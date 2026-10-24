/** Plain searchable content only. Never index image URLs, hidden versions or execution records. */
export function procedureSearchText(blocks: unknown): string {
 if (!Array.isArray(blocks)) return "";
 const strings=(value:unknown):string[]=>Array.isArray(value)?value.flatMap(strings):typeof value==="string"?[value]:[];
 return blocks.slice(0,500).flatMap((block:unknown)=>{
  if(!block||typeof block!=="object")return [];
  const b=block as Record<string,unknown>;
  switch(b.kind){
   case "heading":case "paragraph":return strings(b.text);
   case "image":return [b.alt,b.caption].flatMap(strings);
   case "list":case "checklist":case "steps":case "diagram":return strings(b.items);
   case "table":return [b.header,b.rows].flatMap(strings);
   case "decision":return [b.question,b.yes,b.no].flatMap(strings);
   default:return [];
  }
 }).join(" ").slice(0,100000);
}
