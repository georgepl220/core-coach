'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const{isMainThread,parentPort,workerData}=require('node:worker_threads');
const{openVpk,readResource,createVpk,safeResourcePath}=require('./valve-vpk.cjs');
const{readItemSchema,inspectArcanas,buildArcanaPlan}=require('./local-arcana-catalog.cjs');
const{inspectTerrains,terrainPlan}=require('./local-terrain.cjs');
const problem=(code,message)=>Object.assign(new Error(message),{code});
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function noLinks(filename){for(let current=path.resolve(filename);;){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw problem('UNSAFE_PATH','Ссылки в папках внешнего вида не поддерживаются.');const parent=path.dirname(current);if(parent===current)break;current=parent;}}
function fingerprint(filename,gameDir){
 noLinks(filename);const before=fs.statSync(filename);if(!before.isFile()||before.size>128*1024*1024)throw problem('SOURCE_INVALID','Не удалось проверить исходные ресурсы Dota.');
 const sha256=digest(fs.readFileSync(filename)),after=fs.statSync(filename);
 if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw problem('SOURCE_CHANGED','Dota обновилась во время проверки.');
 const relativePath=path.relative(gameDir,filename).split(path.sep).join('/');
 if(!/^dota\/(?:pak01_dir\.vpk|maps\/dota(?:_[a-z0-9_]+)?\.vpk)$/.test(relativePath))throw problem('UNSAFE_PATH','Неожиданный исходный файл Dota.');
 return{relativePath,sha256,size:after.size,mtimeMs:after.mtimeMs};
}
function context(options){
 if(!path.isAbsolute(options.runtimeDir||'')||!path.isAbsolute(options.gameDir||''))throw problem('INVALID_PATH','Не задана папка Dota или подготовки.');
 const gameDir=path.resolve(options.gameDir),directory=path.resolve(options.runtimeDir,'local-skins'),sourcePath=path.join(gameDir,'dota','pak01_dir.vpk');
 const relative=path.relative(gameDir,directory);
 if(relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)||options.sourcePath&&path.relative(path.resolve(options.sourcePath),sourcePath)!=='')throw problem('UNSAFE_PATH','Некорректная папка ресурсов Dota.');
 noLinks(directory);noLinks(sourcePath);fs.mkdirSync(directory,{recursive:true});
 return{gameDir,directory,sourcePath,catalogPath:path.join(directory,'catalog.json')};
}
function publicCatalog(privateCatalog){
 return{sourceHash:privateCatalog.sourceHash,arcanas:privateCatalog.arcanas.map(row=>({id:row.id,heroId:row.heroId,heroName:row.heroName,name:row.name,supported:row.supported===true,modelCount:row.modelCount,effectCount:row.effectCount,readiness:row.readiness,limitations:row.limitations||[]})),terrains:privateCatalog.terrains.map(row=>({id:row.id,name:row.name,available:row.available===true,limitations:row.limitations||[]}))};
}
function writePrivate(filename,data){
 noLinks(filename);const temporary=filename+'.'+crypto.randomUUID()+'.tmp';
 const descriptor=fs.openSync(temporary,'wx');try{fs.writeFileSync(descriptor,data);fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
 fs.renameSync(temporary,filename);
}
function inspectCatalog(options){
 const ctx=context(options),before=fingerprint(ctx.sourcePath,ctx.gameDir),index=openVpk(ctx.sourcePath),schema=readItemSchema(index);
 const arcanas=inspectArcanas(index,{schema}),terrains=inspectTerrains({gameDir:ctx.gameDir,index,schema});
 const after=fingerprint(ctx.sourcePath,ctx.gameDir);if(after.sha256!==before.sha256)throw problem('SOURCE_CHANGED','Dota обновилась во время подготовки каталога.');
 const privateCatalog={schemaVersion:1,sourceHash:after.sha256,arcanas,terrains};
 writePrivate(ctx.catalogPath,JSON.stringify(privateCatalog));
 return{catalog:publicCatalog(privateCatalog),privateCatalogPath:ctx.catalogPath,sourceFingerprints:[after]};
}
function readCatalog(options){
 const ctx=context(options);if(options.catalogPath&&path.resolve(options.catalogPath)!==ctx.catalogPath)throw problem('UNSAFE_PATH','Неожиданный путь каталога.');
 noLinks(ctx.catalogPath);const stat=fs.statSync(ctx.catalogPath);if(!stat.isFile()||stat.size>16*1024*1024)throw problem('CATALOG_INVALID','Каталог внешнего вида повреждён.');
 const catalog=JSON.parse(fs.readFileSync(ctx.catalogPath,'utf8'));
 if(catalog.schemaVersion!==1||!/^[a-f0-9]{64}$/.test(catalog.sourceHash||'')||!Array.isArray(catalog.arcanas)||!Array.isArray(catalog.terrains)||catalog.arcanas.length>200||catalog.terrains.length>100)throw problem('CATALOG_INVALID','Каталог внешнего вида повреждён.');
 return{...ctx,privateCatalog:catalog};
}
function normalizeSelection(input,catalog){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['arcanaMode','arcanaIds','effectsEnabled','terrainId'].includes(key)))throw problem('INVALID_SELECTION','Некорректный выбор внешнего вида.');
 if(!['none','selected','all_available'].includes(input.arcanaMode)||typeof input.effectsEnabled!=='boolean'||typeof input.terrainId!=='string'||!Array.isArray(input.arcanaIds)||input.arcanaIds.length>200||input.arcanaIds.some(id=>typeof id!=='string'))throw problem('INVALID_SELECTION','Некорректный выбор внешнего вида.');
 const ids=new Set(catalog.arcanas.filter(row=>row.supported).map(row=>row.id));
 if(input.arcanaIds.some(id=>!ids.has(id)))throw problem('UNSUPPORTED_ARCANA','Выбранный облик пока не поддерживается локальной заменой.');
 const arcanaIds=input.arcanaMode==='all_available'?[...ids]:input.arcanaMode==='selected'?[...new Set(input.arcanaIds)]:[];
 const terrain=catalog.terrains.find(row=>row.id===input.terrainId&&row.available);if(!terrain)throw problem('UNSUPPORTED_TERRAIN','Этот ландшафт не найден в установленной Dota.');
 arcanaIds.sort();
 return{arcanaMode:arcanaIds.length?input.arcanaMode:'none',arcanaIds,effectsEnabled:arcanaIds.length&&input.effectsEnabled===true?true:false,terrainId:terrain.id};
}
function stageArchive(directory,kind,plan,sourceIndex){
 if(!plan.size)return null;
 const resources=new Map(),readCache=new Map();
 for(const[target,reference]of plan){
  safeResourcePath(target);safeResourcePath(reference.resource);const index=reference.index||sourceIndex;
  if(!index?.entries?.has(reference.resource))throw problem('RESOURCE_MISSING','Один из ресурсов внешнего вида отсутствует.');
  const key=index.filename+'\0'+reference.resource;if(!readCache.has(key))readCache.set(key,readResource(index,reference.resource));
  resources.set(target,readCache.get(key));
 }
 const bytes=createVpk(resources),staging=path.join(directory,'staging');noLinks(staging);fs.mkdirSync(staging,{recursive:true});
 const stagedPath=path.join(staging,crypto.randomUUID()+'.vpk');writePrivate(stagedPath,bytes);
 return{kind,stagedPath,sha256:digest(bytes),bytes:bytes.length,fileCount:resources.size};
}
function buildCosmetics(options){
 const ctx=readCatalog(options),before=fingerprint(ctx.sourcePath,ctx.gameDir);
 if(before.sha256!==ctx.privateCatalog.sourceHash)throw problem('SOURCE_CHANGED','Dota обновилась: сначала обнови каталог внешнего вида.');
 const index=openVpk(ctx.sourcePath),schema=readItemSchema(index),trustedCatalog={arcanas:inspectArcanas(index,{schema}),terrains:inspectTerrains({gameDir:ctx.gameDir,index,schema})};
 // Cached display metadata never authorizes resource aliases. Rebuild from installed schema.
 const selection=normalizeSelection(options.selection,trustedCatalog),plan=buildArcanaPlan(trustedCatalog.arcanas,selection.arcanaIds,selection.effectsEnabled),files=[],fingerprints=[before];
 const limitations=[...new Set(trustedCatalog.arcanas.filter(row=>selection.arcanaIds.includes(row.id)).flatMap(row=>row.limitations||[]))];
 const counts={heroes:selection.arcanaIds.length,models:selection.arcanaIds.reduce((sum,id)=>sum+(trustedCatalog.arcanas.find(row=>row.id===id)?.modelCount||0),0),effects:selection.effectsEnabled?selection.arcanaIds.reduce((sum,id)=>sum+(trustedCatalog.arcanas.find(row=>row.id===id)?.effectCount||0),0):0,terrainResources:0};
 let terrainFile=null;
 if(selection.terrainId!=='default'){
  const terrain=trustedCatalog.terrains.find(row=>row.id===selection.terrainId),mapPlan=terrainPlan({gameDir:ctx.gameDir,index,terrain,schema});
  const pair=mapPlan.sourceFingerprints;for(const item of Array.isArray(pair)?pair:Object.values(pair||{}))if(item?.path)fingerprints.push(fingerprint(item.path,ctx.gameDir));
  for(const[target,reference]of mapPlan.assetAliases||[]){
   const previous=plan.get(target);if(previous&&(previous.resource!==reference.resource||(previous.index?.filename||index.filename)!==(reference.index?.filename||index.filename)))throw problem('ALIAS_CONFLICT','Ресурсы героев и ландшафта конфликтуют. Текущий образ сохранён.');
   plan.set(target,reference);
  }
  counts.terrainResources=mapPlan.size;limitations.push(...(mapPlan.limitations||[]));
  terrainFile=stageArchive(ctx.directory,'terrain',mapPlan,index);
 }
 const assetFile=stageArchive(ctx.directory,'assets',plan,index);if(assetFile)files.push(assetFile);if(terrainFile)files.push(terrainFile);
 const unique=new Map(fingerprints.map(row=>[row.relativePath,row]));
 for(const record of unique.values())if(fingerprint(path.join(ctx.gameDir,record.relativePath),ctx.gameDir).sha256!==record.sha256)throw problem('SOURCE_CHANGED','Dota обновилась во время подготовки.');
 return{files,selection,counts,sourceFingerprints:[...unique.values()],limitations:[...new Set(limitations)]};
}
if(!isMainThread){
 try{const result=workerData?.action==='catalog'?inspectCatalog(workerData):workerData?.action==='build'?buildCosmetics(workerData):(()=>{throw problem('INVALID_ACTION','Неизвестная операция внешнего вида.');})();parentPort.postMessage({ok:true,result});}
 catch(failure){parentPort.postMessage({ok:false,code:failure.code||'COSMETICS_BUILD_FAILED',message:failure.message||'Не удалось подготовить локальный внешний вид.'});}
 finally{parentPort.close();}
}
module.exports={inspectCatalog,buildCosmetics,normalizeSelection,publicCatalog};

