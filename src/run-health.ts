import {readFile,writeFile,rename,open} from 'node:fs/promises';import path from 'node:path';
export class RunHealth{
 private state:any={uncleanPrevious:false,startedAt:null,previousStartedAt:null};constructor(private root:string){}
 view(){return this.state;}
 private async save(clean:boolean){const file=path.join(this.root,'service-run.json'),temp=file+'.tmp';await writeFile(temp,JSON.stringify({startedAt:this.state.startedAt,clean}),{mode:0o600});const f=await open(temp,'r');try{await f.sync();}finally{await f.close();}await rename(temp,file);const dir=await open(this.root,'r');try{await dir.sync();}finally{await dir.close();}}
 async start(){try{const previous=JSON.parse(await readFile(path.join(this.root,'service-run.json'),'utf8'));this.state.uncleanPrevious=previous.clean!==true;this.state.previousStartedAt=previous.startedAt??null;}catch(e:any){if(e.code!=='ENOENT')this.state.uncleanPrevious=true;}this.state.startedAt=new Date().toISOString();await this.save(false);}
 async finish(){await this.save(true);}
}
