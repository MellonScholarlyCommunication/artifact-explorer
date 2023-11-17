import {QueryEngine} from "@comunica/query-sparql-link-traversal-solid";

const engine = new QueryEngine();

export async function exploreArtifact(artifactUrl: string): Promise<any> {
  const ldes = await getLdesUrl(artifactUrl);
  const eventLogType = await getEventLogType(ldes);

  if (eventLogType === 'LDESinLDP') {
    console.log('LDES in LDP');
    const nodeRelations = await getNodeRelations(ldes);
    console.log(nodeRelations);

    return {
      pages: nodeRelations.transform({
        map: (nodeRelation: any) => {
          return {
            uri: nodeRelation.node,
            sort: nodeRelation.value,
          }
        }
      }),
      url: ldes,
      type: 'LDESinLDP',
    };
  } else if (eventLogType === 'LDES') {
    console.log('LDES');

    const views = await getViews(ldes);

    return {
      pages: views.transform({
        map: (view: any) => {
          return {
            uri: view.view,
            sort: view.view,
          }
        }
      }),
      url: ldes,
      type: 'LDES',
    };
  } else {
    throw new Error('Only LDESinLDP and LDES are supported at the moment');
  }
}

/**
 * Get LDES from artifact by doing a HEAD request and parsing the Link header
 */
async function getLdesUrl(artifactUrl: string) {
  const response = await fetch(artifactUrl, {method: 'HEAD'});
  const linkHeaders = response.headers.get('Link')?.split(',').map((linkHeader: string) => {
    const linkHeaderParts = linkHeader.trim().split(';');
    const url = linkHeaderParts[0].slice(1, -1);
    const rel = linkHeaderParts[1].trim().split('=')[1].slice(1, -1);
    return {url, rel};
  });
  const ldes = linkHeaders?.find((linkHeader: {
    url: string;
    rel: string;
  }) => linkHeader.rel === 'https://w3id.org/ldes#EventStream')?.url;
  if (!ldes) {
    throw new Error('No LDES found');
  }
  console.log('Found LDES: ' + ldes);
  return ldes;
}

async function getEventLogType(ldesUrl?: string) {
  if (!ldesUrl) {
    return false;
  }
  const query = `
    PREFIX ldes: <https://w3id.org/ldes#>
    PREFIX tree: <https://w3id.org/tree#>
    
    SELECT * WHERE {
      {
        SELECT ("LDES" AS ?type) WHERE {
          <${ldesUrl}> a ldes:EventStream;
                       tree:view ?view.
          <${ldesUrl}> tree:member ?member.
        }
      }
      UNION
      {
        SELECT ("LDESinLDP" AS ?type) WHERE {
          <${ldesUrl}> a ldes:EventStream;
                       tree:view ?view.
          ?view a tree:Node;
                tree:viewDescription ?viewDescription.
          ?viewDescription a tree:ViewDescription;
                ldes:managedBy ?ldesInLdp.
          ?ldesInLdp a ldes:LDESinLDPClient.
        }
      }
    } LIMIT 1`;

  const bindings = await (await engine.queryBindings(query, {sources: [ldesUrl], lenient: true})).toArray();
  return bindings[0]?.get('type')?.value;
}

async function getNodeRelations(ldesUrl: string) {
  const query = `
    PREFIX ldes: <https://w3id.org/ldes#>
    PREFIX tree: <https://w3id.org/tree#>
    
    SELECT ?relation ?relationType ?node ?value ?path
    WHERE {
        <${ldesUrl}> a ldes:EventStream;
                   tree:view ?view.
        ?view a tree:Node;
              tree:relation ?relation.
        ?relation a ?relationType;
                  tree:node ?node.
        OPTIONAL { ?relation tree:value ?value. }
        OPTIONAL { ?relation tree:path ?path. }
    }`;

  const bindingsStream = (await engine.queryBindings(query, {sources: [ldesUrl], lenient: true}));

  return bindingsStream.transform({
    map: (binding: any) => {
      return {
        relation: binding.get('relation').value,
        relationType: binding.get('relationType').value,
        node: binding.get('node').value,
        value: binding.get('value')?.value,
        path: binding.get('path')?.value,
      };
    },
  });
}

async function getViews(ldesUrl: string) {
  const query = `
    PREFIX ldes: <https://w3id.org/ldes#>
    PREFIX tree: <https://w3id.org/tree#>
    
    SELECT ?view
    WHERE {
        <${ldesUrl}> a ldes:EventStream;
                     tree:view ?view.
    }`;

  const bindingsStream = (await engine.queryBindings(query, {sources: [ldesUrl], lenient: true, '@comunica/actor-rdf-resolve-hypermedia-links-traverse:traverse': false}));

  return bindingsStream.transform({
    map: (binding: any) => {
      return {
        view: binding.get('view').value,
      };
    },
  });
}

export async function getMembersOfFragment(ldesUrl: string, fragmentUri: string, type: string): Promise<any> {
  if (type === 'LDESinLDP') {
    const query = `
    PREFIX ldes: <https://w3id.org/ldes#>
    PREFIX tree: <https://w3id.org/tree#>
    PREFIX ldp: <http://www.w3.org/ns/ldp#>
    PREFIX dc: <http://purl.org/dc/terms/>
    
    SELECT ?member ?dateTime
    WHERE {
      <${ldesUrl}> a ldes:EventStream;
                   tree:view ?view.
      ?view a tree:Node;
            tree:relation ?relation.
      ?relation a ?relationType;
                tree:node ?node.
      ?node a ldp:BasicContainer;
            ldp:contains ?member.
      ?member a ldp:Resource;
              dc:modified ?dateTime.
      FILTER (?node = <${fragmentUri}>).
    }`;

    // custom fetch with no-cache, so we always get the latest data
    const customFetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      return fetch(url, {
        ...init,
        headers: {
          ...init?.headers,
          'Cache-Control': 'no-cache',
        },
      });
    }) as typeof fetch;

    const bindings = await engine.queryBindings(query, {sources: [ldesUrl], fetch: customFetch, lenient: false});

    return bindings.transform({
      map: async (binding: any) => {
        return {
          content: await getContentOfMember(binding.get('member').value),
          metadata: {
            dateTime: binding.get('dateTime').value,
          },
        };
      },
    });
  } else if (type === 'LDES') {
    const query = `
    PREFIX ldes: <https://w3id.org/ldes#>
    PREFIX tree: <https://w3id.org/tree#>
    PREFIX as: <https://www.w3.org/ns/activitystreams#>
    
    SELECT ?member ?actorUrl ?actorName ?object ?targetUrl ?targetName ?context
    WHERE {
      <${ldesUrl}> a ldes:EventStream;
                    tree:view <${fragmentUri}>;
                    tree:member ?member.
      ?member as:actor ?actorUrl;
        as:object ?object.
      OPTIONAL { ?id as:target ?targetUrl. }
      OPTIONAL { ?actorUrl as:name ?actorName. }
      OPTIONAL { ?targetUrl as:name ?targetName. }
      OPTIONAL { ?id as:context ?context. }
    }`;

    const bindingsStream = (await engine.queryBindings(query, {sources: [ldesUrl], lenient: true}));

    return bindingsStream.transform({
      map: async (binding: any) => {
        const objectTypes = await getTypesOfUri(binding.get('object').value, fragmentUri);
        let objectRelationship = {};
        if (objectTypes.includes('https://www.w3.org/ns/activitystreams#Relationship')) {
          objectRelationship = await getRelationship(binding.get('object').value, fragmentUri);
        }
        return {
          content: {
            id: binding.get('member').value,
            actorUrl: binding.get('actorUrl').value,
            actorName: binding.get('actorName')?.value,
            object: binding.get('object').value,
            targetUrl: binding.get('targetUrl')?.value,
            targetName: binding.get('targetName')?.value,
            context: binding.get('context')?.value,
            types: await getTypesOfUri(binding.get('member').value, fragmentUri),
            objectTypes: objectTypes,
            objectRelationship: objectRelationship,
          },
          metadata: {},
        };
      }
    });
  } else {
    throw new Error('Only LDESinLDP and LDES are supported at the moment');
  }
}

async function getContentOfMember(memberUrl: string) {
  const query = `
  PREFIX as: <https://www.w3.org/ns/activitystreams#>
  
  SELECT ?id ?actorUrl ?actorName ?object ?targetUrl ?targetName ?context
  WHERE {
    ?id as:actor ?actorUrl;
        as:object ?object.
    OPTIONAL { ?id as:target ?targetUrl. }
    OPTIONAL { ?actorUrl as:name ?actorName. }
    OPTIONAL { ?targetUrl as:name ?targetName. }
    OPTIONAL { ?id as:context ?context. }
  } LIMIT 1`;

  const bindings = await (await engine.queryBindings(query, {sources: [memberUrl], lenient: true, '@comunica/actor-rdf-resolve-hypermedia-links-traverse:traverse': false})).toArray();
  if (bindings.length !== 1) {
    console.warn(`Found ${bindings.length} results for content, expected 1.`);
  }
  const content = bindings.map((binding: any) => {
    return {
      id: binding.get('id').value,
      actorUrl: binding.get('actorUrl').value,
      actorName: binding.get('actorName')?.value,
      object: binding.get('object').value,
      targetUrl: binding.get('targetUrl')?.value,
      targetName: binding.get('targetName')?.value,
      context: binding.get('context')?.value,
      types: [] as any,
      objectTypes: [] as any,
      objectRelationship: {} as any,
    };
  })[0];

  // Get types of content
  content.types = await getTypesOfUri(content.id, memberUrl);

  // Get types of object
  content.objectTypes = await getTypesOfUri(content.object, memberUrl);

  if (content.objectTypes.includes('https://www.w3.org/ns/activitystreams#Relationship')) {
    content.objectRelationship = await getRelationship(content.object, memberUrl);
  }

  return content;
}

async function getTypesOfUri(uri: string, source: string) {
  const query = `    
    SELECT ?type
    WHERE {
      <${uri}> a ?type.
    }`;

  const bindings = await (await engine.queryBindings(query, {sources: [source], lenient: true, '@comunica/actor-rdf-resolve-hypermedia-links-traverse:traverse': false})).toArray();
  return bindings.map((binding: any) => binding.get('type').value);
}

async function getRelationship(uri: string, source: string) {
  const query = `
    PREFIX as: <https://www.w3.org/ns/activitystreams#>
    
    SELECT ?subject ?relationship ?object
    WHERE {
        <${uri}> as:subject ?subject;
                 as:relationship ?relationship;
                 as:object ?object.
    } LIMIT 1`;

  const bindings = await (await engine.queryBindings(query, {sources: [source], lenient: true, '@comunica/actor-rdf-resolve-hypermedia-links-traverse:traverse': false})).toArray();
  return bindings.map((binding: any) => {
    return {
      subject: binding.get('subject').value,
      relationship: binding.get('relationship').value,
      object: binding.get('object').value,
    };
  })[0] || {};
}
