import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Presentation,PresentationFile} from '@oai/artifact-tool';
const root=path.resolve('demo');
const skill='C:/Users/aliam/.codex/plugins/cache/openai-primary-runtime/presentations/26.1026.10807/skills/presentations';
const deck=Presentation.create({slideSize:{width:1280,height:720}});
const color={bg:'#0B1822',line:'#2A4455',ink:'#E8F2F6',muted:'#9BB3C3',cyan:'#91D3E8',green:'#87D2AE',red:'#F2838A',amber:'#DFBD78'};
function box(s,x,y,w,h,fill){return s.shapes.add({geometry:'rect',position:{left:x,top:y,width:w,height:h},fill,line:{fill:'none',width:0}});}
function text(s,txt,x,y,w,h,size=30,c=color.ink,bold=false){const a=box(s,x,y,w,h,'none');a.text=txt;a.text.style={typeface:'Segoe UI',fontSize:size,color:c,bold};return a;}
function slide(n,label){const s=deck.slides.add();s.background.fill=color.bg;text(s,'ActorRelay',64,40,700,40,28,color.cyan,true);text(s,`SIMULATED PLANT  /  ${String(n).padStart(2,'0')}`,940,48,276,28,18,color.muted);box(s,64,102,1152,2,color.line);text(s,label,64,134,1120,70,52,color.ink,true);return s;}
let s=slide(1,'One pump change affects the whole plant.');
text(s,'Equipment is connected. Decisions often are not.',64,220,1120,52,30,color.muted);
const tags=[['P-100','More feed'],['TK-101','Level + temperature'],['LV-101','Less headroom'],['TV-101','More steam']];
for(let i=0;i<4;i++){let x=64+i*296;box(s,x,330,264,154,'#142B39');text(s,tags[i][0],x+22,353,225,42,32,color.cyan,true);text(s,tags[i][1],x+22,415,230,40,22,color.muted);if(i===0)text(s,'→',x+262,380,34,40,24,color.muted);}
text(s,'Isolated agents miss downstream effects. Forgotten incidents get repeated.',64,548,1140,86,32,color.ink);
s=slide(2,'Negotiate. Remember. Refuse. Across plants.');
text(s,'Every component gets an agent and durable memory.',64,219,1130,52,30,color.muted);
const steps=[['85% request','REFUSE','LV-101 votes no and cites past runs.',color.red],['65% counter','NEGOTIATE','All voters agree, then a 10-second veto.',color.green],['85% again','REMEMBER','Blocked, citing the run just executed.',color.cyan],['Plant B','ACROSS PLANTS',"Refuses using Plant A's learned rule.",color.cyan]];
for(let i=0;i<4;i++){let x=64+i*296;box(s,x,318,264,210,'#142B39');text(s,steps[i][0],x+22,338,230,44,28,color.ink,true);text(s,steps[i][1],x+22,390,230,30,20,steps[i][3],true);text(s,steps[i][2],x+22,430,230,88,22,color.muted);}
text(s,'No setpoint changes unless the connected components agree.',64,552,1130,45,27,color.cyan);
text(s,'Target demo flow on a simulated plant, not a measured result.',64,610,1130,40,21,color.muted);
s=slide(3,'Memory enforces. Messaging negotiates.');
box(s,64,238,550,205,'#142B39');text(s,'Durable Actors',88,260,490,45,34,color.cyan,true);text(s,"One per component. Holds memory, limits, and calibration, and serializes each actor's writes.",88,324,485,105,27,color.ink);
box(s,646,238,570,205,'#142B39');text(s,'Agent Relay',670,260,510,45,34,color.cyan,true);text(s,'Carries votes, evidence, and counter-proposals between components, and learned rules across plants.',670,324,510,105,27,color.ink);
text(s,'Digital twins predict. ActorRelay makes the components negotiate, remember, and refuse, across every plant you own.',64,500,1145,135,37,color.ink,true);
for(let i=0;i<deck.slides.items.length;i++){await fs.writeFile(path.join(root,'output',`slide-${i+1}.png`),new Uint8Array(await (await deck.export({slide:deck.slides.items[i],format:'png',scale:1})).arrayBuffer()));}
const candidate=path.join(root,'build','candidate.pptx');await(await PresentationFile.exportPptx(deck)).save(candidate);
const {finalizePresentation}=await import(pathToFileURL(path.join(skill,'container_tools/artifact_tool_utils.mjs')).href);
const result=await finalizePresentation({workspaceDir:root,candidatePath:candidate,finalPath:path.join(root,'build','final','ActorRelay.pptx'),explicitTotalSlideCount:3,pythonExecutable:'C:/Users/aliam/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',integrityValidatorPath:path.join(skill,'container_tools/inspect_presentation_package_integrity.py'),layoutValidatorPath:path.join(skill,'container_tools/inspect_presentation_layout_geometry.py'),layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-bullet-geometry','--validate-heading-fit'],fontPolicy:{basis:'design',families:['Segoe UI']},verifyArtifactToolImport:true,receiptPath:path.join(root,'build','validation.json')});console.log(JSON.stringify(result));await fs.copyFile(path.join(root,'build','final','ActorRelay.pptx'),path.join(root,'output','ActorRelay.pptx'));
