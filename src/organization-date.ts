export type OrganizationDate={year:number,month:number|null,day:number|null,source:'creation'|'name'|'modified'|'exif',warning?:string};
export const datePolicies=['creation-name-modified','name-creation-modified','modified'];
function calendar(year:number,month:number|null,day:number|null){if(year<1900||year>2199||month!==null&&(month<1||month>12))return false;if(day!==null){if(month===null||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate())return false;}return true;}
// Recognize explicit separated dates, compact YYYYMMDD, year-month and a standalone year.
// Several different dates are ambiguous: never pick an arbitrary one.
export function dateFromName(name:string):{date:Omit<OrganizationDate,'source'>|null,warning?:string}{
 const found:{year:number,month:number|null,day:number|null}[]=[],ranges:{start:number,end:number}[]=[];let invalid=false;
 const add=(pattern:RegExp,convert:(m:RegExpMatchArray)=>{year:number,month:number|null,day:number|null})=>{for(const m of name.matchAll(pattern)){const start=m.index!+m[1].length,end=m.index!+m[0].length;if(ranges.some(r=>start<r.end&&end>r.start))continue;ranges.push({start,end});const value=convert(m);if(calendar(value.year,value.month,value.day))found.push(value);else invalid=true;}};
 add(/(^|[^\d])((?:19|20|21)\d{2})[-_. /](\d{1,2})[-_. /](\d{1,2})(?!\d)/g,m=>({year:+m[2],month:+m[3],day:+m[4]}));
 add(/(^|[^\d])(\d{1,2})[-_. /](\d{1,2})[-_. /]((?:19|20|21)\d{2})(?!\d)/g,m=>({year:+m[4],month:+m[3],day:+m[2]}));
 add(/(^|[^\d])((?:19|20|21)\d{2})(\d{2})(\d{2})(?!\d)/g,m=>({year:+m[2],month:+m[3],day:+m[4]}));
 add(/(^|[^\d])((?:19|20|21)\d{2})[-_. /](\d{1,2})(?!\d)/g,m=>({year:+m[2],month:+m[3],day:null}));
 add(/(^|[^\d])((?:19|20|21)\d{2})(?!\d)/g,m=>({year:+m[2],month:null,day:null}));
 const unique=[...new Map(found.map(d=>[JSON.stringify(d),d])).values()];return unique.length===1&&!invalid?{date:unique[0]}:{date:null,warning:invalid?'Fecha del nombre no válida; se usa otra fuente.':unique.length>1?'Hay varias fechas en el nombre; se usa otra fuente.':undefined};
}
function fromTimestamp(ms:number,source:OrganizationDate['source']):OrganizationDate|null{if(!Number.isFinite(ms)||ms<=0)return null;const d=new Date(ms);return Number.isFinite(d.getTime())?{year:d.getFullYear(),month:d.getMonth()+1,day:d.getDate(),source}:null;}
export function chooseOrganizationDate(name:string,birthMs:number,modifiedMs:number,policy='creation-name-modified'):OrganizationDate{
 const creation=fromTimestamp(birthMs,'creation'),modified=fromTimestamp(modifiedMs,'modified');const named=dateFromName(name);const title=named.date?{...named.date,source:'name' as const}:null;
 const selected=policy==='modified'?modified:policy==='name-creation-modified'?title??creation??modified:creation??title??modified;
 if(!selected)throw new Error('No se puede determinar una fecha válida para '+name);return {...selected,...(!title&&policy!=='modified'&&named.warning?{warning:named.warning}:{})};
}
export function organizationDateLabel(date:OrganizationDate){const parts=[String(date.year),...(date.month===null?[]:[String(date.month).padStart(2,'0')]),...(date.day===null?[]:[String(date.day).padStart(2,'0')])];return parts.join('-')+' · '+({exif:'captura EXIF',creation:'creación en este disco',name:'nombre del archivo',modified:'modificación'}[date.source])+(date.warning?' · '+date.warning:'');}
