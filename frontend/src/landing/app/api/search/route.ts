import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

// Build a static search index from the docs source. The docs layout's
// RootProvider uses `search={{ options: { type: "static" } }}`, which downloads
// this index and runs the query client-side — so search must be backed by this
// statically generated endpoint or it returns nothing.
export const revalidate = false;

export const { staticGET: GET } = createFromSource(source);
