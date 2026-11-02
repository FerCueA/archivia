import {Database} from 'bun:sqlite';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

/** WAL transactions keep the remote graph and event cursor in one checkpoint. */
export class SyncState {
  private db:Database;
  private previousNodes=new Map<string,string>();
  private previousEntries=new Map<string,string>();
  constructor(directory:string) {
    this.db=new Database(path.join(directory,'sync-state.sqlite'),{create:true,strict:true});
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes(uid TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries(path TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,kind TEXT,path TEXT,phase TEXT,payload TEXT,started TEXT,finished TEXT);
      CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT,kind TEXT,path TEXT,result TEXT,detail TEXT);
      CREATE TABLE IF NOT EXISTS conflicts(id TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    const check=this.db.query('PRAGMA quick_check').get() as any;
    if(!check || Object.values(check)[0]!=='ok')throw Object.assign(new Error('El índice local está dañado'),{code:'STATE_CORRUPT'});
    for(const r of this.db.query('SELECT uid,value FROM nodes').all() as any[])this.previousNodes.set(r.uid,r.value);
    for(const r of this.db.query('SELECT path,value FROM entries').all() as any[])this.previousEntries.set(r.path,r.value);
  }
  meta(key:string) {const r=this.db.query('SELECT value FROM meta WHERE key=?').get(key) as any;return r?JSON.parse(r.value):undefined;}
  setMeta(key:string,value:any) {this.db.query('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,JSON.stringify(value));}
  load() {
    const snapshot=this.meta('snapshot');if(!snapshot)return null;
    return {...snapshot,nodes:[...this.previousNodes.values()].map(v=>JSON.parse(v)),entries:Object.fromEntries([...this.previousEntries].map(([p,v])=>[p,JSON.parse(v)]))};
  }
  save(snapshot:any,nodes:Map<string,any>,hashes:Record<string,string>,records:Record<string,any>,dirty?:Set<string>,localCache?:Map<string,{key:string,hash:string}>) {
    const serializedNodes=new Map(this.previousNodes);
    if(dirty){for(const id of dirty){if(nodes.has(id))serializedNodes.set(id,JSON.stringify(nodes.get(id)));else serializedNodes.delete(id);}}
    else {serializedNodes.clear();for(const [id,n] of nodes)serializedNodes.set(id,JSON.stringify(n));}
    const serializedEntries=new Map<string,string>();
    for(const p of new Set([...Object.keys(hashes),...Object.keys(records)]))serializedEntries.set(p,JSON.stringify({hash:hashes[p],record:records[p],localCache:localCache?.get(p)}));
    this.db.transaction(()=>{
      this.setMeta('snapshot',snapshot);
      const putNode=this.db.query('INSERT OR REPLACE INTO nodes VALUES(?,?)'),delNode=this.db.query('DELETE FROM nodes WHERE uid=?');
      for(const [id,v] of serializedNodes)if(this.previousNodes.get(id)!==v)putNode.run(id,v);
      for(const id of this.previousNodes.keys())if(!serializedNodes.has(id))delNode.run(id);
      const putEntry=this.db.query('INSERT OR REPLACE INTO entries VALUES(?,?)'),delEntry=this.db.query('DELETE FROM entries WHERE path=?');
      for(const [p,v] of serializedEntries)if(this.previousEntries.get(p)!==v)putEntry.run(p,v);
      for(const p of this.previousEntries.keys())if(!serializedEntries.has(p))delEntry.run(p);
    })();
    this.previousNodes=serializedNodes;this.previousEntries=serializedEntries;
  }
  begin(kind:string,relative:string,payload:any={}) {
    const id=randomUUID();this.db.query('INSERT INTO operations VALUES(?,?,?,?,?,?,NULL)').run(id,kind,relative,'prepared',JSON.stringify(payload),new Date().toISOString());return id;
  }
  update(id:string,payload:any) {this.db.query('UPDATE operations SET payload=? WHERE id=?').run(JSON.stringify(payload),id);}
  end(id:string,result='complete') {this.db.query('UPDATE operations SET phase=?,finished=? WHERE id=?').run(result,new Date().toISOString(),id);}
  pending() {return (this.db.query("SELECT * FROM operations WHERE phase='prepared'").all() as any[]).map(r=>({...r,payload:JSON.parse(r.payload)}));}
  history(kind:string,relative:string,result:string,detail='',time=new Date().toISOString()) {
    this.db.query('INSERT INTO history(time,kind,path,result,detail) VALUES(?,?,?,?,?)').run(time,kind,relative,result,detail);
    this.db.exec('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 500); DELETE FROM operations WHERE phase!=\'prepared\' AND id NOT IN (SELECT id FROM operations ORDER BY started DESC LIMIT 500);');
  }
  historyList(limit=60) {return this.db.query('SELECT time,kind,path,result,detail FROM history ORDER BY id DESC LIMIT ?').all(limit);}
  saveConflicts(values:any[]) {this.db.transaction(()=>{this.db.exec('DELETE FROM conflicts');const q=this.db.query('INSERT INTO conflicts VALUES(?,?)');for(const v of values)q.run(v.id,JSON.stringify(v));})();}
  conflicts() {return (this.db.query('SELECT value FROM conflicts').all() as any[]).map(r=>JSON.parse(r.value));}
  close(){this.db.close();}
}
