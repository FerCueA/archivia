// Linux statx explicitly reports whether birth time exists. Never substitute ctime.
const script=String.raw`import sys,json,ctypes,struct
libc=ctypes.CDLL(None,use_errno=True)
statx=getattr(libc,'statx',None)
values=[]
for filename in json.load(sys.stdin):
    value=0
    if statx:
        buffer=ctypes.create_string_buffer(256)
        result=statx(-100,filename.encode(),0x100,0x800,buffer)
        if result==0 and struct.unpack_from('I',buffer.raw,0)[0]&0x800:
            seconds,nanos=struct.unpack_from('qI',buffer.raw,80)
            value=seconds*1000+nanos/1000000
    values.append(value)
print(json.dumps(values))`;
export async function creationTimes(files:string[]){if(!files.length)return [];if(process.platform!=='linux')return files.map(()=>0);const proc=Bun.spawn(['/usr/bin/python3','-c',script],{stdin:new Blob([JSON.stringify(files)]),stdout:'pipe',stderr:'ignore'});const text=await new Response(proc.stdout).text();if(await proc.exited!==0)return files.map(()=>0);try{const values=JSON.parse(text);if(!Array.isArray(values)||values.length!==files.length)return files.map(()=>0);return values.map(v=>typeof v==='number'&&Number.isFinite(v)?v:0);}catch{return files.map(()=>0);}}
