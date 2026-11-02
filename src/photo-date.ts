import type {OrganizationDate} from './organization-date';
// Read capture metadata only. Never decode pixels, execute image content or use EXIF modification dates.
const script=String.raw`import sys,json,os,stat,resource,datetime,warnings
resource.setrlimit(resource.RLIMIT_AS,(512*1024*1024,512*1024*1024))
resource.setrlimit(resource.RLIMIT_CPU,(10,10))
from PIL import Image
warnings.simplefilter('error',Image.DecompressionBombWarning)
results=[]
for filename in json.load(sys.stdin):
    result={}
    try:
        fd=os.open(filename,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        with os.fdopen(fd,'rb') as stream:
            info=os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):raise ValueError('not a file')
            with Image.open(stream) as image:
                exif=image.getexif()
                value=exif.get(36867)
                if not value:
                    try:value=exif.get_ifd(34665).get(36867)
                    except Exception:pass
                if value:
                    if isinstance(value,bytes):value=value.decode('ascii')
                    date=datetime.datetime.strptime(str(value).strip('\x00 '),'%Y:%m:%d %H:%M:%S')
                    if not 1900<=date.year<=2199:raise ValueError('date range')
                    result={'date':{'year':date.year,'month':date.month,'day':date.day,'source':'exif'}}
            after=os.fstat(stream.fileno())
            if (info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError('changed')
    except Exception:
        result={'warning':'No se pudo leer una fecha EXIF válida; se usa otra fuente.'}
    results.append(result)
print(json.dumps(results))`;
export const photoExtensions=new Set(['jpg','jpeg','tif','tiff','png','webp']);
export async function photoDates(files:string[]):Promise<{date?:OrganizationDate,warning?:string}[]>{if(!files.length)return [];try{const proc=Bun.spawn(['/usr/bin/python3','-c',script],{stdin:new Blob([JSON.stringify(files)]),stdout:'pipe',stderr:'ignore'});const output=await new Response(proc.stdout).text();if(await proc.exited!==0)throw Error();const values=JSON.parse(output);if(!Array.isArray(values)||values.length!==files.length)throw Error();return values;}catch{return files.map(()=>({warning:'EXIF no disponible; se usa otra fuente.'}));}}
