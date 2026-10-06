import{i as S,n as A,r as G}from"./geometry-wkb-DRXc57N7.js";import{n as C}from"./gpkg-ogr-contents-C2eo6Kvv.js";var b=1196444487,Y=10300,u=4326,l="geom",c="fid",w='GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]';function N(e){return`"${e.replaceAll('"','""')}"`}function y(e,t){let n=e.replace(/[^\p{L}\p{N}_]+/gu,"_").replace(/^_+/,"");n||(n="field"),(n.toLowerCase()===c||n.toLowerCase()===l)&&(n=`${n}_`);let r=n,o=1;for(;t.has(r.toLowerCase());)r=`${n}_${o}`,o+=1;return t.add(r.toLowerCase()),r}function k(e){let t=!1,n=!0;for(const r of e)if(r!=null)if(typeof r=="number"&&Number.isFinite(r))t=!0,Number.isInteger(r)||(n=!1);else if(typeof r=="boolean")t=!0;else return"TEXT";return t?n?"INTEGER":"REAL":"TEXT"}function P(e,t){return e==null?null:t==="TEXT"?typeof e=="object"?JSON.stringify(e):String(e):typeof e=="boolean"?e?1:0:typeof e=="number"&&Number.isFinite(e)?e:null}function M(e){if(!e)return null;const t=G(e),n=new Uint8Array(8),r=new DataView(n.buffer);n[0]=71,n[1]=80,n[2]=0,n[3]=1,r.setInt32(4,u,!0);const o=new Uint8Array(n.length+t.length);return o.set(n,0),o.set(t,n.length),o}function x(e){return e.size===1?[...e][0].toUpperCase():"GEOMETRY"}function h(e){e.run(`PRAGMA application_id = ${b};`),e.run(`PRAGMA user_version = ${Y};`),e.run(`CREATE TABLE gpkg_spatial_ref_sys (
      srs_name TEXT NOT NULL,
      srs_id INTEGER NOT NULL PRIMARY KEY,
      organization TEXT NOT NULL,
      organization_coordsys_id INTEGER NOT NULL,
      definition TEXT NOT NULL,
      description TEXT
    );`);const t=e.prepare("INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?);");try{t.run(["Undefined cartesian SRS",-1,"NONE",-1,"undefined",null]),t.run(["Undefined geographic SRS",0,"NONE",0,"undefined",null]),t.run(["WGS 84 geodetic",u,"EPSG",u,w,null])}finally{t.free()}e.run(`CREATE TABLE gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY,
      data_type TEXT NOT NULL,
      identifier TEXT UNIQUE,
      description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      min_x DOUBLE,
      min_y DOUBLE,
      max_x DOUBLE,
      max_y DOUBLE,
      srs_id INTEGER,
      CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id)
        REFERENCES gpkg_spatial_ref_sys(srs_id)
    );`),e.run(`CREATE TABLE gpkg_geometry_columns (
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      geometry_type_name TEXT NOT NULL,
      srs_id INTEGER NOT NULL,
      z TINYINT NOT NULL,
      m TINYINT NOT NULL,
      CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
      CONSTRAINT uk_gc_table_name UNIQUE (table_name),
      CONSTRAINT fk_gc_tn FOREIGN KEY (table_name)
        REFERENCES gpkg_contents(table_name),
      CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id)
        REFERENCES gpkg_spatial_ref_sys(srs_id)
    );`),e.run(`CREATE TABLE gpkg_ogr_contents (
      table_name TEXT NOT NULL PRIMARY KEY,
      feature_count INTEGER DEFAULT NULL
    );`)}function B(e,t,n){const r=t.features??[];if(r.length===0)throw new Error("The layer has no features to export.");const o=y(n,new Set),m=[],p=new Set;for(const a of r)for(const i of Object.keys(a.properties??{}))p.has(i)||(p.add(i),m.push(i));const U=new Set([c,l]),f=m.map(a=>({key:a,name:y(a,U),type:k(r.map(i=>i.properties?.[a]))})),T=A(),g=new Set;for(const a of r)a.geometry&&(g.add(a.geometry.type),S(T,a.geometry));const s=new e.Database;try{h(s);const a=f.map(E=>`${N(E.name)} ${E.type}`).join(", ");s.run(`CREATE TABLE ${N(o)} (
        ${N(c)} INTEGER PRIMARY KEY AUTOINCREMENT,
        ${N(l)} BLOB${a?`, ${a}`:""}
      );`);const i=[l,...f.map(E=>E.name)],d=i.map(()=>"?").join(", "),I=s.prepare(`INSERT INTO ${N(o)} (${i.map(N).join(", ")}) VALUES (${d});`);try{s.run("BEGIN;");for(const E of r){const R=[M(E.geometry)];for(const O of f)R.push(P(E.properties?.[O.key],O.type));I.run(R)}s.run("COMMIT;")}finally{I.free()}const _=Number.isFinite(T.minX)&&Number.isFinite(T.minY),L=s.prepare(`INSERT INTO gpkg_contents
        (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
       VALUES (?, 'features', ?, '', ?, ?, ?, ?, ?);`);try{L.run([o,o,_?T.minX:null,_?T.minY:null,_?T.maxX:null,_?T.maxY:null,u])}finally{L.free()}return s.run("INSERT INTO gpkg_geometry_columns VALUES (?, ?, ?, ?, 0, 0);",[o,l,x(g),u]),s.run("INSERT INTO gpkg_ogr_contents (table_name, feature_count) VALUES (?, ?);",[o,r.length]),s.export()}finally{s.close()}}async function X(e,t){return B(await C(),e,t)}export{X as writeGeoPackage};
