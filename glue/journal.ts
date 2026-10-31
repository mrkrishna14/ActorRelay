import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export class Journal {
 private db:Database;
 constructor(path=process.env.GLUE_JOURNAL_PATH??".runtime/glue.sqlite"){
  if(path!==":memory:")mkdirSync(dirname(path),{recursive:true});
  this.db=new Database(path,{create:true});
  this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS entries (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id))");
 }
 get<T=any>(kind:string,id:string):T|undefined {const row=this.db.query("SELECT value FROM entries WHERE kind=? AND id=?").get(kind,id) as {value:string}|null;return row?JSON.parse(row.value):undefined;}
 set(kind:string,id:string,value:unknown){this.db.query("INSERT INTO entries(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value").run(kind,id,JSON.stringify(value));}
 remove(kind:string,id:string){this.db.query("DELETE FROM entries WHERE kind=? AND id=?").run(kind,id);}
 list<T=any>(kind:string):{id:string,value:T}[]{return (this.db.query("SELECT id,value FROM entries WHERE kind=?").all(kind) as {id:string,value:string}[]).map(row=>({id:row.id,value:JSON.parse(row.value)}));}
 close(){this.db.close();}
}
