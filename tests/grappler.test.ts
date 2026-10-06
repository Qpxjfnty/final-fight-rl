import test from 'node:test';
import assert from 'node:assert/strict';
import {createEncounter,legalCommands,preview,step} from '../src/engine';
import {distance,key,type Command,type Enemy,type EnemyKind,type Pos,type State} from '../src/model';

function fixture():State {
 const state=createEncounter();state.openingStepAvailable=false;state.enemies=[];
 state.player.grabbedBy=null;Object.assign(state.player,{x:5,y:4});return state;
}
function enemy(state:State,pos:Pos,kind:EnemyKind='brawler'):Enemy {
 const value:Enemy={...pos,id:state.enemies.length+1,kind,hp:12,maxHp:12,intent:null,down:0,recovery:0};
 state.enemies.push(value);return value;
}
const position=(actor:Pos):Pos=>({x:actor.x,y:actor.y});
const find=(state:State,id:number):Enemy=>state.enemies.find(e=>e.id===id)!;
function tell(attacker:Enemy,cell:Pos):void {
 attacker.intent={kind:attacker.kind==='grappler'?'grab':attacker.kind==='lunger'?'lunge':'punch',
  damage:attacker.kind==='grappler'?0:attacker.kind==='lunger'?4:3,cells:[position(cell)]};
}
function apply(state:State,command:Command):State {
 const original=structuredClone(state),p=preview(state,command),r=step(state,command);
 assert.equal(p.valid,true,p.reason);assert.equal(r.accepted,true,r.reason);
 assert.equal(r.state.beat,state.beat+1);assert.deepEqual(state,original);
 assert.equal(r.state.player.hp,Math.max(0,state.player.hp-p.incomingDamage));
 for(const hit of p.hits)assert.equal(find(r.state,hit.enemyId).hp,Math.max(0,find(state,hit.enemyId).hp-hit.damage));
 assert.deepEqual(r,step(state,command));return r.state;
}

test('grapplers travel up to two legal steps and telegraph a grab without grabbing on that beat',()=>{
 const state=fixture(),g=enemy(state,{x:5,y:1},'grappler');
 const next=apply(state,{type:'Wait'}),after=find(next,g.id);
 assert.equal(distance(g,after),2);assert.equal(distance(after,next.player),1);
 assert.equal(after.intent?.kind,'grab');assert.equal(after.intent?.damage,0);
 assert.deepEqual(after.intent?.cells,[position(next.player)]);
 assert.equal(next.player.grabbedBy,null);assert.equal(next.player.hp,24);
});

test('an adjacent grappler readies without moving and commits the player cell',()=>{
 const state=fixture(),g=enemy(state,{x:4,y:4},'grappler');
 const told=apply(state,{type:'Wait'});assert.deepEqual(position(find(told,g.id)),position(g));
 const command:Command={type:'Step',target:{x:5,y:5}},p=preview(told,command);
 assert.deepEqual(p.grabs,[]);assert.deepEqual(p.cancelled,[g.id]);
 const escaped=apply(told,command);assert.equal(escaped.player.grabbedBy,null);
 assert.equal(find(escaped,g.id).intent,null);assert.equal(find(escaped,g.id).recovery,0);
 assert.deepEqual(position(find(escaped,g.id)),position(g),'A missed grab spends the grappler turn.');
});

test('a vault can dodge a committed grab without recovery or immediate retargeting',()=>{
 const state=fixture(),g=enemy(state,{x:4,y:4},'grappler'),crossed=enemy(state,{x:6,y:4});
 tell(g,state.player);const p=preview(state,{type:'Vault',targetId:crossed.id});
 assert.deepEqual(p.cancelled,[g.id]);assert.deepEqual(p.grabs,[]);
 const next=apply(state,{type:'Vault',targetId:crossed.id});
 assert.equal(next.player.grabbedBy,null);assert.deepEqual(position(next.player),{x:7,y:4});
 assert.equal(find(next,g.id).intent,null);assert.equal(find(next,g.id).recovery,0);
});

test('a prepared grab applies next beat, deals no damage and breaks a newly started combo',()=>{
 const state=fixture(),g=enemy(state,{x:4,y:4},'grappler'),target=enemy(state,{x:6,y:4});tell(g,state.player);
 const command:Command={type:'Strike',targetId:target.id},p=preview(state,command);
 assert.deepEqual(p.grabs,[g.id]);assert.equal(p.incomingDamage,0);
 const next=apply(state,command);assert.equal(next.player.grabbedBy,g.id);
 assert.equal(next.player.hp,24);assert.equal(next.stats.damageTaken,0);
 assert.equal(next.player.combo,null);assert.equal(next.stats.brokenCombos,1);
 assert.equal(find(next,g.id).recovery,0);assert.equal(find(next,g.id).intent,null);
});

test('a preparing grappler cannot be thrown directly and rejected commands spend nothing',()=>{
 const state=fixture(),g=enemy(state,{x:6,y:4},'grappler');tell(g,state.player);
 const command:Command={type:'Throw',targetId:g.id,direction:{x:1,y:0}},original=structuredClone(state);
 assert.equal(preview(state,command).valid,false);
 assert.equal(legalCommands(state).some(c=>c.type==='Throw'&&c.targetId===g.id),false);
 const r=step(state,command);assert.equal(r.accepted,false);assert.equal(r.state,state);assert.deepEqual(state,original);
 g.intent=null;assert.equal(preview(state,command).valid,true,'A grappler without a grab tell can be thrown.');
});

test('striking a preparing grappler interrupts its grab and starts a normal standing combo',()=>{
 const state=fixture(),g=enemy(state,{x:6,y:4},'grappler');tell(g,state.player);
 const command:Command={type:'Strike',targetId:g.id},p=preview(state,command);
 assert.deepEqual(p.interrupted,[g.id]);assert.deepEqual(p.grabs,[]);assert.equal(p.comboStage,1);
 const next=apply(state,command);assert.equal(next.player.grabbedBy,null);
 assert.deepEqual(next.player.combo,{targetId:g.id,hits:1});assert.equal(find(next,g.id).hp,11);
 assert.equal(find(next,g.id).intent,null);
});

test('throwing another enemy into a preparing grappler interrupts it and knocks both down',()=>{
 const state=fixture(),body=enemy(state,{x:5,y:3}),g=enemy(state,{x:6,y:4},'grappler');tell(g,state.player);
 const command:Command={type:'Throw',targetId:body.id,direction:{x:1,y:1}},p=preview(state,command);
 assert.equal(p.valid,true);assert.deepEqual(p.interrupted,[g.id]);assert.deepEqual(p.grabs,[]);
 assert.deepEqual(p.hits,[{enemyId:body.id,damage:1},{enemyId:g.id,damage:1}]);
 const next=apply(state,command);assert.equal(next.player.grabbedBy,null);
 for(const e of [body,g]){assert.equal(find(next,e.id).hp,11);assert.equal(find(next,e.id).down,2);assert.equal(find(next,e.id).intent,null);}
});

test('held players cannot Step or Throw, while Wait, Strike and a legal Vault remain available',()=>{
 const state=fixture(),g=enemy(state,{x:4,y:4},'grappler'),other=enemy(state,{x:6,y:4});state.player.grabbedBy=g.id;
 const blocked:Command[]=[{type:'Step',target:{x:5,y:5}},{type:'Throw',targetId:other.id,direction:{x:1,y:0}}];
 const original=structuredClone(state);
 for(const command of blocked){assert.equal(preview(state,command).valid,false);const r=step(state,command);assert.equal(r.accepted,false);assert.equal(r.state,state);}
 assert.deepEqual(state,original);
 const available=legalCommands(state);assert.ok(available.every(c=>c.type!=='Step'&&c.type!=='Throw'));
 assert.ok(available.some(c=>c.type==='Wait'));assert.ok(available.some(c=>c.type==='Strike'&&c.targetId===other.id));
 assert.ok(available.some(c=>c.type==='Vault'&&c.targetId===other.id));
 const next=apply(state,{type:'Wait'});assert.equal(next.player.grabbedBy,g.id);
 assert.deepEqual(position(find(next,g.id)),position(g));assert.equal(find(next,g.id).intent,null);
});

test('a held Strike against another enemy deals one damage without a combo and leaves the holder idle',()=>{
 const state=fixture(),g=enemy(state,{x:4,y:4},'grappler'),other=enemy(state,{x:6,y:4});state.player.grabbedBy=g.id;
 const command:Command={type:'Strike',targetId:other.id},p=preview(state,command);
 assert.equal(p.comboStage,0);assert.deepEqual(p.hits,[{enemyId:other.id,damage:1}]);assert.deepEqual(p.releases,[]);
 const next=apply(state,command);assert.equal(find(next,other.id).hp,11);
 assert.equal(next.player.combo,null);assert.equal(next.player.grabbedBy,g.id);
 assert.equal(find(next,g.id).intent,null);assert.deepEqual(position(find(next,g.id)),position(g));
});

test('striking the holder releases the player, but the escape strike cannot start a combo',()=>{
 const state=fixture(),g=enemy(state,{x:4,y:4},'grappler');state.player.grabbedBy=g.id;
 const command:Command={type:'Strike',targetId:g.id},p=preview(state,command);
 assert.deepEqual(p.releases,[g.id]);assert.equal(p.comboStage,0);
 const freed=apply(state,command);assert.equal(freed.player.grabbedBy,null);assert.equal(freed.player.combo,null);
 assert.equal(find(freed,g.id).hp,11);assert.equal(find(freed,g.id).intent,null);
 const following=apply(freed,command);assert.deepEqual(following.player.combo,{targetId:g.id,hits:1});
});

test('vaulting over any enemy releases a hold and the former holder cannot chase on the release beat',()=>{
 const state=fixture(),g=enemy(state,{x:4,y:4},'grappler'),other=enemy(state,{x:6,y:4});state.player.grabbedBy=g.id;
 const command:Command={type:'Vault',targetId:other.id};assert.deepEqual(preview(state,command).releases,[g.id]);
 const next=apply(state,command);assert.equal(next.player.grabbedBy,null);assert.deepEqual(position(next.player),{x:7,y:4});
 assert.equal(next.player.vaultCooldown,3);assert.deepEqual(position(find(next,g.id)),position(g));assert.equal(find(next,g.id).intent,null);
});

test('incoming damage releases a hold before a later grappler can grab again',()=>{
 const state=fixture(),holder=enemy(state,{x:4,y:4},'grappler'),attacker=enemy(state,{x:5,y:3}),later=enemy(state,{x:6,y:4},'grappler');
 state.player.grabbedBy=holder.id;tell(attacker,state.player);tell(later,state.player);
 const p=preview(state,{type:'Wait'});assert.deepEqual(p.releases,[holder.id]);assert.deepEqual(p.grabs,[later.id]);
 const next=apply(state,{type:'Wait'});assert.equal(next.player.hp,21);assert.equal(next.player.grabbedBy,later.id);
 assert.equal(find(next,holder.id).intent,null);assert.deepEqual(position(find(next,holder.id)),position(holder));
});

test('a second grappler cannot replace a current holder before a later damage release',()=>{
 const state=fixture(),holder=enemy(state,{x:4,y:4},'grappler'),earlier=enemy(state,{x:6,y:4},'grappler'),attacker=enemy(state,{x:5,y:3});
 state.player.grabbedBy=holder.id;tell(earlier,state.player);tell(attacker,state.player);
 const p=preview(state,{type:'Wait'});assert.deepEqual(p.grabs,[]);assert.deepEqual(p.releases,[holder.id]);
 const next=apply(state,{type:'Wait'});assert.equal(next.player.grabbedBy,null);assert.equal(next.player.hp,21);
 assert.equal(find(next,earlier.id).intent,null,'The rejected second grab still spends its committed turn.');
});

test('a later grab cannot land after an earlier attacker kills the player',()=>{
 const state=fixture(),attacker=enemy(state,{x:4,y:4}),g=enemy(state,{x:6,y:4},'grappler');
 state.player.hp=3;tell(attacker,state.player);tell(g,state.player);
 assert.deepEqual(preview(state,{type:'Wait'}).grabs,[]);
 const next=apply(state,{type:'Wait'});assert.equal(next.phase,'dead');assert.equal(next.player.hp,0);
 assert.equal(next.player.grabbedBy,null);assert.deepEqual(legalCommands(next),[]);
});

test('a waking adjacent grappler readies immediately but grabs only on the following beat',()=>{
 const state=fixture(),g=enemy(state,{x:4,y:4},'grappler');g.down=1;
 const waking=apply(state,{type:'Wait'});assert.equal(find(waking,g.id).down,0);
 assert.equal(find(waking,g.id).intent?.kind,'grab');assert.equal(waking.player.grabbedBy,null);
 const held=apply(waking,{type:'Wait'});assert.equal(held.player.grabbedBy,g.id);assert.equal(held.player.hp,24);
});

test('waking far enemies do not move, then a grappler can approach two cells next beat',()=>{
 const state=fixture(),g=enemy(state,{x:5,y:1},'grappler');g.down=1;
 const waking=apply(state,{type:'Wait'});assert.equal(find(waking,g.id).down,0);
 assert.deepEqual(position(find(waking,g.id)),position(g));assert.equal(find(waking,g.id).intent,null);
 const following=apply(waking,{type:'Wait'});assert.equal(distance(g,find(following,g.id)),2);
 assert.equal(find(following,g.id).intent?.kind,'grab');
});

test('a waking lunger commits its current ray without moving and respects intervening bodies',()=>{
 for(const blocked of [false,true]){
  const state=fixture(),lunger=enemy(state,{x:2,y:4},'lunger');lunger.down=1;
  if(blocked)enemy(state,{x:3,y:4}).down=2;
  const next=apply(state,{type:'Wait'}),after=find(next,lunger.id);
  assert.equal(after.down,0);assert.deepEqual(position(after),position(lunger));assert.equal(next.player.hp,24);
  if(blocked)assert.equal(after.intent,null);
  else{assert.equal(after.intent?.kind,'lunge');assert.deepEqual(after.intent?.cells,[{x:3,y:4},{x:4,y:4},{x:5,y:4}]);}
 }
});

test('grappler pathfinding can pass one occupied corner but not a gap between two bodies',()=>{
 for(const two of [false,true]){
  const state=fixture();Object.assign(state.player,{x:6,y:5});const g=enemy(state,{x:4,y:3},'grappler');
  enemy(state,{x:5,y:3}).down=2;if(two)enemy(state,{x:4,y:4}).down=2;
  const next=apply(state,{type:'Wait'}),after=find(next,g.id);
  if(two){assert.ok(distance(after,next.player)>1);assert.equal(after.intent,null);assert.notDeepEqual(position(after),{x:5,y:4});}
  else{assert.deepEqual(position(after),{x:5,y:4});assert.equal(after.intent?.kind,'grab');}
  const actors=[next.player,...next.enemies.filter(e=>e.hp>0)];assert.equal(new Set(actors.map(key)).size,actors.length);
 }
});

test('downed Strikes deal one chip damage without starting or advancing a combo',()=>{
 let state=fixture();const target=enemy(state,{x:6,y:4});target.down=2;
 for(const hp of [11,10]){
  const command:Command={type:'Strike',targetId:target.id},p=preview(state,command);
  assert.equal(p.comboStage,0);assert.deepEqual(p.hits,[{enemyId:target.id,damage:1}]);
  state=apply(state,command);assert.equal(find(state,target.id).hp,hp);
  assert.equal(state.player.combo,null);assert.equal(state.stats.completedCombos,0);assert.equal(find(state,target.id).intent,null);
 }
 const awake=apply(state,{type:'Strike',targetId:target.id});assert.deepEqual(awake.player.combo,{targetId:target.id,hits:1});
});

test('downed chip freezes an existing two-hit combo, and a chip kill never counts as a finisher',()=>{
 const state=fixture(),target=enemy(state,{x:6,y:4});target.down=2;target.hp=2;state.player.combo={targetId:target.id,hits:2};
 const command:Command={type:'Strike',targetId:target.id};
 assert.equal(preview(state,command).comboStage,0);
 const chipped=apply(state,command);assert.equal(find(chipped,target.id).hp,1);
 assert.deepEqual(chipped.player.combo,{targetId:target.id,hits:2});assert.equal(chipped.stats.completedCombos,0);
 const killed=apply(chipped,command);assert.equal(find(killed,target.id).hp,0);assert.equal(killed.player.combo,null);
 assert.equal(killed.stats.completedCombos,0);assert.equal(killed.stats.finisherKills,0);assert.equal(killed.phase,'won');
 assert.equal(step(killed,command).accepted,false);
});

test('switching to a downed target breaks the old combo without starting a replacement',()=>{
 const state=fixture(),first=enemy(state,{x:4,y:4}),downed=enemy(state,{x:6,y:4});downed.down=1;
 state.player.combo={targetId:first.id,hits:2};
 const next=apply(state,{type:'Strike',targetId:downed.id});assert.equal(find(next,downed.id).hp,11);
 assert.equal(next.player.combo,null);assert.equal(next.stats.brokenCombos,1);assert.equal(next.stats.completedCombos,0);
 assert.equal(find(next,downed.id).intent,null,'The chip strike suppresses a same-beat wake tell.');
});

test('downed bodies remain throwable but take no Throw or collision damage',()=>{
 for(const bodyDown of [0,1,2])for(const victimDown of [0,1,2]){
  const state=fixture(),body=enemy(state,{x:6,y:4}),victim=enemy(state,{x:7,y:4});body.down=bodyDown;victim.down=victimDown;
  const command:Command={type:'Throw',targetId:body.id,direction:{x:1,y:0}},p=preview(state,command);
  assert.deepEqual(p.hits,[{enemyId:body.id,damage:bodyDown?0:1},{enemyId:victim.id,damage:victimDown?0:1}]);
  const next=apply(state,command);assert.equal(find(next,body.id).hp,bodyDown?12:11);assert.equal(find(next,victim.id).hp,victimDown?12:11);
  assert.equal(find(next,body.id).down,2);assert.equal(find(next,victim.id).down,2);
 }
});
