import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,readFile,readdir,mkdir,rm,lstat,symlink} from 'node:fs/promises';
import {trashRecoverably} from '../src/local-trash';
import os from 'node:os';import path from 'node:path';
test('trash contains original content and a restorable encoded path',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'proton-trash-'));const source=path.join(dir,'carpeta con espacios');const trash=path.join(dir,'Trash');await mkdir(source);await writeFile(path.join(source,'a.txt'),'preservar');await symlink('a.txt',path.join(source,'enlace'));
 try{const target=await trashRecoverably(source,trash);expect(await readFile(path.join(target,'a.txt'),'utf8')).toBe('preservar');expect((await lstat(path.join(target,'enlace'))).isSymbolicLink()).toBe(true);expect(await lstat(source).catch(()=>null)).toBeNull();const names=await readdir(path.join(trash,'info'));const info=await readFile(path.join(trash,'info',names[0]),'utf8');expect(info).toContain('carpeta%20con%20espacios');expect(info).toContain('[Trash Info]');}finally{await rm(dir,{recursive:true,force:true});}
});
