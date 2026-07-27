import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

const search = createFromSource(source);

export const dynamic = "force-static";

export const GET = search.staticGET;
