import {QueryEngine} from "@comunica/query-sparql";

const engine = new QueryEngine();

export async function exploreArtifact(artifactUrl: string) {
  const ldes = await getLdesUrl(artifactUrl);
  const ldesViews = await getLdesViews(ldes);
  const ldesView = ldesViews[0];
  const isLDESinLDPClient = await isLDESinLDP(ldesView.viewDescription ?? ldesView.view);

  if (isLDESinLDPClient) {
    const nodeRelations = await getNodeRelations(ldesView.view);

    return {
      pages: nodeRelations.sort((a: any, b: any) => a.value < b.value ? -1 : 1).map((nodeRelation: any) => nodeRelation.node),
      type: 'LDESinLDP',
    };
  } else {
    throw new Error('Only LDES in LDP is supported at the moment');
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

async function getLdesViews(ldesUrl: string) {
  const query = `
    PREFIX ldes: <https://w3id.org/ldes#>
    PREFIX tree: <https://w3id.org/tree#>
    
    SELECT ?view ?viewDescription
    WHERE {
      ?ldes a ldes:EventStream;
            tree:view ?view.
      ?view a tree:Node.
      OPTIONAL {
        ?view tree:viewDescription ?viewDescription.
        ?viewDescription a tree:ViewDescription.
      }
    }`;

  const bindings = await (await engine.queryBindings(query, {sources: [ldesUrl]})).toArray();
  return bindings.map((binding: any) => {
    return {
      view: binding.get('view').value,
      viewDescription: binding.get('viewDescription')?.value,
    };
  });
}

async function isLDESinLDP(viewDescriptionUrl?: string) {
  if (!viewDescriptionUrl) {
    return false;
  }
  const query = `
    PREFIX ldes: <https://w3id.org/ldes#>
    PREFIX tree: <https://w3id.org/tree#>
    
    ASK {
      <${viewDescriptionUrl}> a tree:ViewDescription;
                              ldes:managedBy ?ldesInLdp.
      ?ldesInLdp a ldes:LDESinLDPClient.
    }`;

  return await engine.queryBoolean(query, {sources: [viewDescriptionUrl]});
}

async function getNodeRelations(nodeUrl: string) {
  const query = `
    PREFIX ldes: <https://w3id.org/ldes#>
    PREFIX tree: <https://w3id.org/tree#>
    
    SELECT ?relation ?relationType ?node ?value ?path
    WHERE {
      <${nodeUrl}> a tree:Node;
                   tree:relation ?relation.
     ?relation a ?relationType;
               tree:node ?node.
     OPTIONAL { ?relation tree:value ?value. }
     OPTIONAL { ?relation tree:path ?path. }
    }`;

  const bindings = await (await engine.queryBindings(query, {sources: [nodeUrl]})).toArray();
  return bindings.map((binding: any) => {
    return {
      relation: binding.get('relation').value,
      relationType: binding.get('relationType').value,
      node: binding.get('node').value,
      value: binding.get('value')?.value,
      path: binding.get('path')?.value,
    };
  });
}

export async function getMembersOfFragment(fragmentUrl: string, type: string) {
  if (type === 'LDESinLDP') {
    const query = `
    PREFIX ldp: <http://www.w3.org/ns/ldp#>
    
    SELECT ?member ?dateTime
    WHERE {
      <${fragmentUrl}> a ldp:BasicContainer;
                       ldp:contains ?member.
      ?member a ldp:Resource;
              dc:modified ?dateTime.
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

    const bindings = await (await engine.queryBindings(query, {sources: [fragmentUrl], fetch: customFetch})).toArray();

    return await Promise.all(bindings.map(async (binding: any) => {
      return {
        content: await getContentOfMember(binding.get('member').value),
        metadata: {
          dateTime: binding.get('dateTime').value,
        },
      };
    }));
  } else {
    throw new Error('Only LDES in LDP is supported at the moment');
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
  }`;

  const bindings = await (await engine.queryBindings(query, {sources: [memberUrl]})).toArray();
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
    const relationshipQuery = `
    PREFIX as: <https://www.w3.org/ns/activitystreams#>
    
    SELECT ?subject ?relationship ?object
    WHERE {
        <${content.object}> as:subject ?subject;
                            as:relationship ?relationship;
                            as:object ?object.
    }`;

    const relationshipBindings = await (await engine.queryBindings(relationshipQuery, {sources: [memberUrl]})).toArray();
    if (relationshipBindings.length !== 1) {
      console.warn(`Found ${relationshipBindings.length} results for relationship, expected 1.`);
    } else {
      content.objectRelationship = relationshipBindings.map((binding: any) => {
        return {
          subject: binding.get('subject').value,
          relationship: binding.get('relationship').value,
          object: binding.get('object').value,
        };
      })[0];
    }
  }

  return content;
}

async function getTypesOfUri(uri: string, source: string) {
  const query = `    
    SELECT ?type
    WHERE {
      <${uri}> a ?type.
    }`;

  const bindings = await (await engine.queryBindings(query, {sources: [source]})).toArray();
  return bindings.map((binding: any) => binding.get('type').value);
}
