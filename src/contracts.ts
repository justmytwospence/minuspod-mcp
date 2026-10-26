import {z} from "zod";
import {metadataText} from "./podcast-search.js";

export type Obj = Record<string,any>;
export const MAX_ITEMS=100;
export const scalar=z.union([z.string().max(4000),z.number().finite(),z.boolean(),z.null()]);
export function fields(names:readonly string[]) {
  return z.strictObject(Object.fromEntries(names.map(key=>[key,scalar.optional()])));
}
export function pick(obj:unknown, names:readonly string[]):Obj {
  if (!obj || typeof obj!=="object" || Array.isArray(obj)) return {};
  const source=obj as Obj;
  return Object.fromEntries(names.filter(key=>source[key]===null ||
    typeof source[key]==="string" || typeof source[key]==="boolean" ||
    (typeof source[key]==="number" && Number.isFinite(source[key])))
    .map(key=>[key,typeof source[key]==="string" ? metadataText(source[key],key==="description"?4000:200) : source[key]]));
}
export function rows(value:unknown, optional=false):Obj[] {
  if (value===undefined && optional) return [];
  if (!Array.isArray(value) || value.some(row=>!row || typeof row!=="object" || Array.isArray(row)))
    throw new Error("Unexpected MinusPod metadata response; inspect the app locally");
  return value;
}
export function jsonText(value:unknown):string {
  // Last line of defence for the configured app secret, including unusual text.
  const secret=process.env.MINUSPOD_ADMIN_PASSWORD;
  return JSON.stringify(value,(_key,item)=>typeof item==="string" && secret ? item.replaceAll(secret,"[redacted]") : item);
}
