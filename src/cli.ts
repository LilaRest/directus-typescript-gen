#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";
import yargs from "yargs";
import openApiTs, { OpenAPI3 } from "openapi-typescript";

const Argv = z.object({
  host: z.string(),
  email: z.string(),
  password: z.string(),
  passwordIsStaticToken: z.boolean(),
  appTypeName: z.string(),
  directusTypeName: z.string(),
  allTypeName: z.string(),
  specOutFile: z.string().nullish(),
  outFile: z.string(),
});

type Argv = z.infer<typeof Argv>;

const argv = Argv.parse(
  await yargs(process.argv.slice(2))
    .option(`host`, { demandOption: true, type: `string` })
    .option(`email`, { demandOption: true, type: `string` })
    .option(`password`, { demandOption: true, type: `string` })
    .option(`passwordIsStaticToken`, {
      demandOption: false,
      type: `boolean`,
      default: false,
    })
    .option(`appTypeName`, {
      alias: `typeName`,
      demandOption: false,
      type: `string`,
      default: `AppCollections`,
    })
    .option(`directusTypeName`, {
      demandOption: false,
      type: `string`,
      default: `DirectusCollections`,
    })
    .option(`allTypeName`, {
      demandOption: false,
      type: `string`,
      default: `Collections`,
    })
    .option(`specOutFile`, { demandOption: false, type: `string` })
    .option(`outFile`, { demandOption: true, type: `string` })
    .help().argv,
);

const {
  host,
  email,
  password,
  passwordIsStaticToken,
  appTypeName: appCollectionsTypeName,
  directusTypeName: directusCollectionsTypeName,
  allTypeName: allCollectionsTypeName,
  specOutFile,
  outFile,
} = argv;

let token;
if (passwordIsStaticToken) {
  token = password;
}
else {
  const response = await fetch(new URL(`/auth/login`, host).href, {
    method: `post`,
    body: JSON.stringify({ email, password, mode: `json` }),
    headers: {
      "Content-Type": `application/json`,
    },
  });

  const json = await response.json() as {
    data: {
      access_token: string;
    };
  };

  token = json.data.access_token;
}

type EnrichedOpenAPI3 = OpenAPI3 & {
  components: {
    schemas: {
      [key: string]: {
        [`x-collection`]: string;
      };
    };
  };
};

type SpecResponse = EnrichedOpenAPI3 | {
  errors: unknown[];
};

const spec = (await (
  await fetch(`${host}/server/specs/oas`, {
    method: `get`,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
).json()) as SpecResponse;

function assertSpecHasNoErrors(spec: SpecResponse): asserts spec is EnrichedOpenAPI3 {
  if ('errors' in spec && spec.errors.length) {
    console.error(spec.errors);
    throw new Error('Could not generate TypeScript definitions');
  }
}

assertSpecHasNoErrors(spec);

if (specOutFile) {
  await writeFile(
    resolve(process.cwd(), specOutFile),
    JSON.stringify(spec, null, 2),
    {
      encoding: `utf-8`,
    },
  );
}

const baseSource = await openApiTs(spec);

const exportAppCollectionsProperties: string[] = [];
const exportDirectusCollectionsProperties: string[] = [];
let exportAllCollectionsLines: string[] = [];

for (let schemaKey of Object.keys(spec.components.schemas)) {

  // Rename schema key and figure out if it's an app collection
  let isAppCollection = false;
  let formatedSchemaKey = "";
  if (schemaKey.startsWith("Items")) {
    formatedSchemaKey = "App" + schemaKey.slice(5);
    isAppCollection = true;
  }
  else {
    formatedSchemaKey = "Directus" + schemaKey;
  }
  
  // Build and append property line
  const propertyLine = `  "${formatedSchemaKey}": components["schemas"]["${schemaKey}"];`;
  (isAppCollection
    ? exportAppCollectionsProperties
    : exportDirectusCollectionsProperties
    ).push(propertyLine);
    
  // Build and append export line
  if (schemaKey !== "x-metadata") {   
    const exportLine = `export type ${formatedSchemaKey} = components["schemas"]["${schemaKey}"];`;
    exportAllCollectionsLines.push(exportLine)
  }
}

const exportAllCollectionsTypes = exportAllCollectionsLines.join(`\n`);

const exportAppCollectionsType = `export type ${appCollectionsTypeName} = {\n${exportAppCollectionsProperties.join(
  `\n`,
)}\n};\n`;

const exportDirectusCollectionsType = `export type ${directusCollectionsTypeName} = {\n${exportDirectusCollectionsProperties.join(
  `\n`,
)}\n};\n`;

const exportCollectionsType = `export type ${allCollectionsTypeName} = ${directusCollectionsTypeName} & ${appCollectionsTypeName};\n`;

const source = [
  "declare global {",
  baseSource,
  exportAppCollectionsType,
  exportDirectusCollectionsType,
  exportCollectionsType,
  exportAllCollectionsTypes,
  "}",
].join(`\n`);

await writeFile(resolve(process.cwd(), outFile), source, {
  encoding: `utf-8`,
});

/*
 - System collections : prefixed with "Directus"
 - Custom app-specific collections : prefixed with "App"
 - All System collections bundled under : "DirectusCollections"
 - All custom app-specific collections bundled under : "AppCollections"
 - All collections bundled under : "Collections"
*/