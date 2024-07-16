import {QueryEngine} from "@comunica/query-sparql";
import {Bindings} from "@rdfjs/types";

const engine = new QueryEngine();

type Relationship = {
   subject: string | undefined,
   relationship: string | undefined,
   object: string | undefined,
}
type Member = {
   id: string | undefined,
   actorUrl: string | undefined,
   actorName: string | undefined,
   object: string | undefined,
   targetUrl: string | undefined,
   targetName: string | undefined,
   context: string | undefined,
   types: string[],
   objectTypes: string[],
   objectRelationship: Relationship | undefined,
}

export async function exploreArtifact(artifactUrl: string): Promise<AsyncIterator<Member>> {
   const eventLog = await getEventLogUrl(artifactUrl);

   return await getMembersOfFragment(eventLog);
}

/**
 * Get LDES from artifact by doing a HEAD request and parsing the Link header
 */
async function getEventLogUrl(artifactUrl: string) {
   const response = await fetch(artifactUrl, {method: 'HEAD'});
   const linkHeaders = response.headers.get('Link-Template')?.split(',').map((linkHeader: string) => {
      const linkHeaderParts = linkHeader.trim().split(';');
      const url = linkHeaderParts[0].slice(1, -1);
      const rel = linkHeaderParts[1].trim().split('=')[1].slice(1, -1);
      return {url, rel};
   });
   const eventLog = linkHeaders?.find((linkHeader: {
      url: string;
      rel: string;
   }) => linkHeader.rel === 'eventlog')?.url;
   if (!eventLog) {
      throw new Error('No event log found');
   }
   console.log('Found event log: ' + eventLog);
   return eventLog;
}

async function getMembersOfFragment(ldesUrl: string): Promise<AsyncIterator<Member>> {

   const query = `
    PREFIX ldes: <https://w3id.org/ldes#>
    PREFIX tree: <https://w3id.org/tree#>
    PREFIX as: <https://www.w3.org/ns/activitystreams#>
    
    SELECT ?member
    WHERE {
      ?id a ldes:EventStream;
                    tree:member ?member.
    }`;

   const bindingsStream = (await engine.queryBindings(query, {sources: [ldesUrl], lenient: true}));

   return bindingsStream.transform({
      map: async (binding: Bindings): Promise<Member> => {
         const memberUrl = binding.get('member')!.value;

         return await getContentOfMember(memberUrl);
      }
   }) as unknown as Promise<AsyncIterator<Member>>;
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

   const bindings = await (await engine.queryBindings(query, {sources: [memberUrl], lenient: true})).toArray();
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

async function getTypesOfUri(uri: string | undefined, source: string) {
   if (!uri) {
      return [];
   }

   const query = `    
    SELECT ?type
    WHERE {
      <${uri}> a ?type.
    }`;

   const bindings = await (await engine.queryBindings(query, {sources: [source], lenient: true})).toArray();
   return bindings.map((binding: any) => binding.get('type').value);
}

async function getRelationship(uri: string | undefined, source: string): Promise<Relationship> {
   if (!uri) {
      return {object: undefined, relationship: undefined, subject: undefined};
   }

   const query = `
    PREFIX as: <https://www.w3.org/ns/activitystreams#>
    
    SELECT ?subject ?relationship ?object
    WHERE {
        <${uri}> as:subject ?subject;
                 as:relationship ?relationship;
                 as:object ?object.
    } LIMIT 1`;

   const bindings = await (await engine.queryBindings(query, {sources: [source], lenient: true})).toArray();
   return bindings.map((binding: any) => {
      return {
         subject: binding.get('subject').value,
         relationship: binding.get('relationship').value,
         object: binding.get('object').value,
      };
   })[0] || {};
}
