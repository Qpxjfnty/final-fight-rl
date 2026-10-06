import { createEncounter, legalCommands, preview, step } from './engine';
import { CONFIG, DIRS, add, distance, equal, key, type Action, type Command, type Enemy, type Pos, type Preview } from './model';
import './style.css';

const ACTIONS: { name: Action; icon: string; hint: string }[] = [
  { name: 'Step', icon: '↗', hint: 'Move one cell' },
  { name: 'Strike', icon: '✦', hint: 'Interrupt · build a combo' },
  { name: 'Throw', icon: '↠', hint: '1 damage · knock down' },
  { name: 'Vault', icon: '⌒', hint: 'Cross an adjacent enemy' },
  { name: 'Wait', icon: '·', hint: 'Spend one beat' },
];
const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const DIRECTION_KEYS: Record<string, Pos> = {
  q: { x: -1, y: -1 }, w: { x: 0, y: -1 }, e: { x: 1, y: -1 },
  a: { x: -1, y: 0 }, d: { x: 1, y: 0 },
  z: { x: -1, y: 1 }, x: { x: 0, y: 1 }, c: { x: 1, y: 1 },
  ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
};
const escape = (value: string | number) => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const ENEMY_NAMES = { brawler: 'Brawler', lunger: 'Lunger', grappler: 'Grappler' };
const ENEMY_GLYPHS = { brawler: 'B', lunger: 'L', grappler: 'G' };
const enemyName = (enemy: Enemy) => `${ENEMY_NAMES[enemy.kind]} ${enemy.id}`;
const glyph = (enemy: Enemy) => ENEMY_GLYPHS[enemy.kind];

/** A self-contained, unsaved combat experiment. All aiming is free until confirmation. */
export function mountGame(root: HTMLElement): { render(): void; destroy(): void } {
  let state = createEncounter();
  let action: Action | null = null;
  let command: Command | null = null;
  let throwTarget: number | null = null;
  let inspected: Pos | null = null;
  let inspectedEnemyId: number | null = null;
  let hovered: Pos | null = null;
  let inspectMode = false;
  let helpOpen = false;
  let feedback = '';
  let destroyed = false;

  function enemyAt(pos: Pos): Enemy | undefined { return state.enemies.find(enemy => enemy.hp > 0 && equal(enemy, pos)); }
  function byId(id: number): Enemy | undefined { return state.enemies.find(enemy => enemy.id === id); }
  function targetLabel(id: number): string { const enemy = byId(id); return enemy ? enemyName(enemy) : `Enemy ${id}`; }
  function held(): boolean { return state.player.grabbedBy !== null; }
  function actionBlocked(next: Action): boolean { return held() && (next === 'Step' || next === 'Throw'); }
  function actionHint(next: Action, fallback: string): string {
    if (actionBlocked(next)) return 'Unavailable while grabbed';
    if (held() && next === 'Strike') return '1 damage · no combo · hit grabber to escape';
    if (held() && next === 'Vault') return 'Escape across any adjacent enemy';
    if (next === 'Step' && state.openingStepAvailable) return 'Free if your first action';
    return fallback;
  }
  function selectedEnemy(): Enemy | undefined {
    if (hovered) return enemyAt(hovered);
    const pinned = inspectedEnemyId === null ? undefined : byId(inspectedEnemyId);
    if (inspectMode) return pinned && pinned.hp > 0 ? pinned : inspected ? enemyAt(inspected) : undefined;
    if (throwTarget !== null) return byId(throwTarget);
    if (command && 'targetId' in command) return byId(command.targetId);
    return pinned && pinned.hp > 0 ? pinned : inspected ? enemyAt(inspected) : undefined;
  }
  function aimHint(): string {
    if (inspectMode) return 'Inspection · select a cell. Press I or Escape to return.';
    if (held() && !command) {
      if (action === 'Strike') return 'Strike the grappler holding you to break free. Held strikes cannot build a combo.';
      if (action === 'Vault') return 'Vault over any adjacent enemy to escape. The landing must be empty; normal cooldown applies.';
      return `Held by ${targetLabel(state.player.grabbedBy!)}. Strike your grabber or Vault to escape.`;
    }
    if (state.openingStepAvailable) {
      if (command?.type === 'Step') return 'Confirm your opening Step to move free, then act again.';
      if (command) return 'This action starts the beat and gives up your free opening Step.';
      if (action === 'Step') return 'Choose an adjacent empty cell. Step first to move free.';
      if (!action) return 'Step first for one free move, then act again. Other actions start the beat.';
    }
    if (command) return 'Check the forecast, then confirm. Aiming costs no time.';
    if (action === 'Step') return 'Choose an adjacent empty cell.';
    if (action === 'Throw' && throwTarget !== null) return `Throw ${targetLabel(throwTarget)} · choose a direction.`;
    if (action === 'Strike') return 'Choose an adjacent enemy to strike.';
    if (action === 'Throw') return 'Choose an adjacent enemy to throw.';
    if (action === 'Vault') return 'Choose an adjacent enemy to vault over.';
    return 'Choose an action, then a target. Arrows move immediately.';
  }
  function setAction(next: Action): void {
    if (state.phase !== 'combat') return;
    if (actionBlocked(next)) { feedback = `${next} is unavailable while grabbed. Strike the grabber or Vault to escape.`; render(); return; }
    action = next;
    command = next === 'Wait' ? { type: 'Wait' } : null;
    throwTarget = null;
    inspectMode = false;
    feedback = '';
    render();
  }
  function clearSelection(): void {
    action = null; command = null; throwTarget = null; inspectMode = false; feedback = '';
    render();
  }
  function commit(next = command): void {
    if (!next || state.phase !== 'combat') return;
    const result = step(state, next);
    if (!result.accepted) { feedback = result.reason || 'That action is unavailable.'; render(); return; }
    state = result.state;
    if (inspectedEnemyId !== null) {
      const pinned = byId(inspectedEnemyId);
      if (pinned && pinned.hp > 0) inspected = { x: pinned.x, y: pinned.y };
      else inspectedEnemyId = null;
    }
    action = null; command = null; throwTarget = null; feedback = ''; inspectMode = false;
    render();
  }
  function chooseCell(pos: Pos): void {
    inspected = pos;
    inspectedEnemyId = enemyAt(pos)?.id ?? null;
    feedback = '';
    if (inspectMode || !action || state.phase !== 'combat') { render(); return; }
    if (action === 'Throw' && throwTarget !== null) {
      const target = byId(throwTarget);
      if (target && !equal(target, pos)) chooseDirection({ x: Math.sign(pos.x - target.x), y: Math.sign(pos.y - target.y) });
      else render();
      return;
    }
    const enemy = enemyAt(pos);
    if (action === 'Step') command = { type: 'Step', target: pos };
    if (action === 'Strike' || action === 'Vault') {
      command = enemy ? { type: action, targetId: enemy.id } : null;
      if (!enemy) feedback = 'Select an adjacent enemy.';
    }
    if (action === 'Throw') {
      command = null;
      if (enemy?.intent?.kind === 'grab') feedback = 'This grappler is preparing a grab. Interrupt it with Strike or a thrown body first.';
      else if (enemy && distance(state.player, enemy) === 1) throwTarget = enemy.id;
      else feedback = 'Select an adjacent enemy to throw.';
    }
    render();
  }
  function chooseDirection(direction: Pos): void {
    if (inspectMode) {
      const next = add(inspected || state.player, direction);
      inspected = { x: Math.max(1, Math.min(CONFIG.width, next.x)), y: Math.max(1, Math.min(CONFIG.height, next.y)) };
      inspectedEnemyId = enemyAt(inspected)?.id ?? null;
      render(); return;
    }
    if (action === 'Throw' && throwTarget !== null) {
      command = { type: 'Throw', targetId: throwTarget, direction };
      feedback = ''; render(); return;
    }
    const pos = add(state.player, direction);
    if (!action) { commit({ type: 'Step', target: pos }); return; }
    chooseCell(pos);
  }
  function inspectionHtml(): string {
    const inspectionPos = hovered || inspected;
    const enemy = selectedEnemy();
    if (enemy) {
      const status = enemy.hp <= 0 ? 'Defeated'
        : enemy.id === state.player.grabbedBy ? 'Holding you · movement and throws locked'
        : enemy.down > 0 ? `Down · chip strikes only · stands in ${enemy.down} ${enemy.down === 1 ? 'beat' : 'beats'}`
        : enemy.recovery > 0 ? `Recovering · ${enemy.recovery} beat`
        : enemy.intent?.kind === 'grab' ? 'Grab prepared · cannot be thrown directly'
        : enemy.intent ? `${enemy.intent.kind === 'lunge' ? 'Lunge' : 'Punch'} committed · ${enemy.intent.damage} damage`
        : enemy.kind === 'grappler' ? 'Ready · moves up to two cells, then prepares a grab' : 'Ready to move or prepare an attack';
      const intentHint = enemy.intent?.kind === 'lunge'
        ? 'Red cells mark the committed path. Dodge to avoid damage; this lunger still advances to its planned landing cell, stopping before bodies. A miss has no recovery.'
        : enemy.intent?.kind === 'grab'
        ? 'Orange brackets mark its grab target. Step away, Strike it, or hit it with a thrown body. Throw cannot directly grab a grappler while it prepares its own grab.'
        : 'Red cells mark the committed attack. Leave its cells to make this brawler cancel and stay put, without recovery.';
      const extra = enemy.down > 0 ? 'Strikes deal 1 damage but cannot start or advance a combo. Throws and body collisions deal no damage while down; this body remains throwable. If not interrupted, it can prepare an attack as soon as it stands.'
        : enemy.id === state.player.grabbedBy ? 'Strike this grappler or Vault over any adjacent enemy to break free. Taking damage also releases you; it is not protection.' : '';
      return `<div class="lab-inspection-title"><span class="lab-enemy-letter ${enemy.kind}">${glyph(enemy)}</span><strong>${escape(enemyName(enemy))}</strong><span>${Math.max(0, enemy.hp)}/${enemy.maxHp}</span></div><p>${escape(status)}</p>${enemy.intent ? `<p class="lab-fine">${intentHint}</p>` : ''}${extra ? `<p class="lab-fine">${extra}</p>` : ''}`;
    }
    if (inspectionPos && equal(inspectionPos, state.player)) return `<div class="lab-inspection-title"><span class="lab-player-letter">◆</span><strong>You${held() ? ' · grabbed' : ''}</strong><span>${state.player.hp}/${state.player.maxHp}</span></div><p>${held() ? `Held by ${escape(targetLabel(state.player.grabbedBy!))}. Step and Throw are locked. Strike the grabber or Vault to escape. Held strikes deal 1 damage and cannot build a combo.` : 'Strike to suppress a threat. Finish three consecutive strikes against one standing target.'}</p>`;
    return `<div class="lab-inspection-title"><strong>${inspectionPos ? `Cell ${inspectionPos.x}, ${inspectionPos.y}` : 'Read the crowd'}</strong></div><p>${inspectionPos ? 'Empty floor. Select a nearby cell with Step to reposition.' : 'Hover to inspect; click to pin. Choose an action before aiming. Hovering never changes your aim.'}</p>`;
  }
  function previewHtml(forecast: Preview | null): string {
    if (!forecast) return '<p class="lab-forecast-empty">Aim an action to see its damage, movement, and incoming attacks.</p>';
    if (!forecast.valid) return `<p class="lab-invalid">${escape(forecast.reason)}</p><p class="lab-fine">No beat is spent.</p>`;
    const lines: string[] = [];
    if (forecast.freeStep) lines.push('<li><b>Free opening step</b> — enemies wait; act again.</li>');
    if (forecast.comboStage) lines.push(`<li><b>Combo ${forecast.comboStage}/3</b>${forecast.comboStage === 3 ? ' · finisher' : ''}</li>`);
    for (const hit of forecast.hits) lines.push(hit.damage === 0
      ? `<li>${escape(targetLabel(hit.enemyId))}: <b>0 damage</b> · downed body resists throws and collisions</li>`
      : `<li>${escape(targetLabel(hit.enemyId))}: <b>−${hit.damage} HP</b></li>`);
    if (command?.type === 'Strike' && !forecast.comboStage) {
      if (byId(command.targetId)?.down) lines.push('<li><b>No combo progress:</b> this target is down.</li>');
      else if (held()) lines.push('<li><b>No combo progress:</b> you start this strike grabbed.</li>');
    }
    if (forecast.destination) lines.push(`<li>Land at <b>${forecast.destination.x}, ${forecast.destination.y}</b></li>`);
    for (const push of forecast.pushes) lines.push(equal(push.from, push.to)
      ? `<li><b>Collision in place:</b> ${escape(targetLabel(push.enemyId))}</li>`
      : `<li>${escape(targetLabel(push.enemyId))} → <b>${push.to.x}, ${push.to.y}</b></li>`);
    for (const lunge of forecast.lunges) lines.push(`<li><b>Lunge:</b> ${escape(targetLabel(lunge.enemyId))} → <b>${lunge.to.x}, ${lunge.to.y}</b></li>`);
    if (forecast.knockdowns.length) lines.push(`<li><b>Knock down:</b> ${forecast.knockdowns.map(id => escape(targetLabel(id))).join(', ')} · this beat + two</li>`);
    if (forecast.interrupted.length) lines.push(`<li><b>Suppress:</b> ${forecast.interrupted.map(id => escape(targetLabel(id))).join(', ')}</li>`);
    if (forecast.cancelled.length) lines.push(`<li><b>No hit:</b> ${forecast.cancelled.map(id => escape(targetLabel(id))).join(', ')} · no recovery</li>`);
    if (forecast.releases.length) lines.push(`<li class="lab-release-text"><b>Break free from:</b> ${forecast.releases.map(id => escape(targetLabel(id))).join(', ')}</li>`);
    const damagingThreats = forecast.threats.filter(threat => threat.damage > 0);
    if (damagingThreats.length) lines.push(`<li class="lab-danger-text"><b>Still hits:</b> ${damagingThreats.map(threat => `${escape(targetLabel(threat.enemyId))} (${threat.damage})`).join(', ')}</li>`);
    const newHolds = forecast.grabs.filter(id => !forecast.releases.includes(id));
    if (forecast.grabs.length) lines.push(`<li class="lab-grab-text"><b>Will grab you:</b> ${forecast.grabs.map(id => `${escape(targetLabel(id))}${forecast.releases.includes(id) ? ' (released this beat)' : ''}`).join(', ')}${newHolds.length ? ' · Step and Throw locked' : ''}</li>`);
    if (forecast.incomingDamage && forecast.comboStage > 0 && forecast.comboStage < 3) lines.push('<li class="lab-danger-text">Taking damage breaks this combo.</li>');
    if (forecast.grabs.length && forecast.comboStage > 0 && forecast.comboStage < 3) lines.push('<li class="lab-grab-text">Being grabbed breaks this combo, even if the hold is released this beat.</li>');
    if (!lines.length) lines.push('<li>Spend one beat in place.</li>');
    const staysHeld = held() && !forecast.releases.includes(state.player.grabbedBy!);
    const atRisk = forecast.incomingDamage > 0 || forecast.grabs.length > 0 || staysHeld;
    const incomingLabel = newHolds.length ? 'Incoming danger' : forecast.grabs.length ? 'Damage · grab releases' : staysHeld ? 'Still grabbed' : 'Incoming damage';
    const incomingValue = newHolds.length ? `${forecast.incomingDamage ? `−${forecast.incomingDamage} + ` : ''}GRAB` : staysHeld && !forecast.incomingDamage ? 'HELD' : `${forecast.incomingDamage ? '−' : ''}${forecast.incomingDamage}`;
    return `<ul class="lab-forecast-list">${lines.join('')}</ul><div class="lab-incoming ${atRisk ? 'is-danger' : 'is-safe'}" data-testid="lab-incoming"><span>${incomingLabel}</span><strong>${incomingValue}</strong></div>`;
  }
  function directionHtml(): string {
    if (action !== 'Throw' || throwTarget === null) return '';
    const order = [7, 0, 1, 6, -1, 2, 5, 4, 3];
    return `<div class="lab-throw-aim"><div class="lab-compass" aria-label="Throw direction">${order.map(index => index < 0 ? '<span aria-hidden="true">↠</span>' : `<button type="button" data-direction="${index}" aria-label="Throw ${DIRECTIONS[index]}" class="${command?.type === 'Throw' && equal(command.direction, DIRS[index]) ? 'is-selected' : ''}">${DIRECTIONS[index]}</button>`).join('')}</div><div><b>Choose a direction</b><p>Up to ${CONFIG.throwRange} cells. Aim from the selected enemy.</p><button type="button" class="lab-text-button" data-command="retarget">Change target</button></div></div>`;
  }
  function terminalHtml(): string {
    if (state.phase === 'combat') return '';
    return `<section class="lab-result" data-testid="lab-result"><span class="lab-eyebrow">${state.phase === 'won' ? 'Arena clear' : 'Fight over'}</span><h2>${state.phase === 'won' ? 'You made an opening.' : 'The crowd closed in.'}</h2><p>${state.beat} beats · ${state.stats.completedCombos} complete combos · ${state.stats.brokenCombos} broken · ${state.stats.finisherKills} finisher kills</p><p>${state.stats.damageTaken} damage taken · ${state.stats.cancelledAttacks} attacks cancelled</p><div class="lab-action-stats">${ACTIONS.map(item => `<span>${item.name} <b>${state.stats.actions[item.name]}</b></span>`).join('')}</div><button type="button" class="lab-confirm" data-command="restart" data-testid="lab-restart">Restart this encounter <span>↻</span></button></section>`;
  }
  function render(): void {
    if (destroyed) return;
    const focus = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focus?.dataset.action ? `[data-action="${focus.dataset.action}"]` : focus?.dataset.command ? `[data-command="${focus.dataset.command}"]` : focus?.dataset.direction ? `[data-direction="${focus.dataset.direction}"]` : focus?.dataset.cell ? `[data-cell="${focus.dataset.cell}"]` : null;
    const forecast = command ? preview(state, command) : null;
    const living = state.enemies.filter(enemy => enemy.hp > 0);
    const attacks = new Set(living.flatMap(enemy => enemy.intent && enemy.intent.kind !== 'grab' ? enemy.intent.cells.map(key) : []));
    const grabCells = new Set(living.flatMap(enemy => enemy.intent?.kind === 'grab' ? enemy.intent.cells.map(key) : []));
    const path = new Set(forecast?.valid ? forecast.path.map(key) : []);
    const landing = new Set(forecast?.valid ? [...forecast.pushes.map(push => key(push.to)), ...forecast.lunges.map(lunge => key(lunge.to)), ...(forecast.destination ? [key(forecast.destination)] : [])] : []);
    const legalTargets = new Set<string>();
    if (action) for (const candidate of legalCommands(state)) {
      if (candidate.type !== action) continue;
      if ('target' in candidate) legalTargets.add(key(candidate.target));
      else if ('targetId' in candidate) { const target = byId(candidate.targetId); if (target) legalTargets.add(key(target)); }
    }
    const cells: string[] = [];
    for (let y = 0; y <= CONFIG.height + 1; y++) for (let x = 0; x <= CONFIG.width + 1; x++) {
      const pos = { x, y }; const cellKey = key(pos);
      const wall = x === 0 || y === 0 || x === CONFIG.width + 1 || y === CONFIG.height + 1;
      if (wall) { cells.push('<div class="lab-cell lab-wall" aria-hidden="true"><span>▪</span></div>'); continue; }
      const player = equal(state.player, pos);
      const enemy = enemyAt(pos);
      const comboHits = enemy && state.player.combo?.targetId === enemy.id ? state.player.combo.hits : 0;
      const stateLabel = enemy ? enemy.down ? `, down ${enemy.down}, takes only chip strikes` : enemy.id === state.player.grabbedBy ? ', holding player' : enemy.recovery ? ', recovering' : enemy.intent?.kind === 'grab' ? ', grab prepared, cannot be thrown directly' : enemy.intent ? ', attack committed' : '' : '';
      const label = `${x}, ${y}: ${player ? `Player, ${state.player.hp} HP${held() ? `, held by ${targetLabel(state.player.grabbedBy!)}` : ''}` : enemy ? `${enemyName(enemy)}, ${enemy.hp} HP${stateLabel}` : 'empty'}${attacks.has(cellKey) ? ', threatened by damage' : ''}${grabCells.has(cellKey) ? ', threatened by grab' : ''}`;
      const aimTarget = throwTarget !== null ? byId(throwTarget) : command && 'targetId' in command ? byId(command.targetId) : undefined;
      const selectedCell = command?.type === 'Step' ? equal(command.target, pos) : aimTarget && equal(aimTarget, pos);
      cells.push(`<button type="button" class="lab-cell ${player ? 'lab-player' : ''} ${enemy ? `lab-enemy ${enemy.kind}` : ''} ${attacks.has(cellKey) ? 'is-threatened' : ''} ${grabCells.has(cellKey) ? 'is-grab-threatened' : ''} ${player && held() ? 'is-grabbed' : ''} ${enemy?.id === state.player.grabbedBy ? 'is-holding' : ''} ${path.has(cellKey) ? 'is-path' : ''} ${landing.has(cellKey) ? 'is-landing' : ''} ${legalTargets.has(cellKey) ? 'is-legal' : ''} ${selectedCell ? 'is-aimed' : ''} ${inspected && equal(inspected, pos) ? 'is-inspected' : ''} ${enemy?.down ? 'is-down' : ''}" data-cell="${cellKey}" data-testid="lab-cell-${x}-${y}" aria-label="${escape(label)}" title="${escape(label)}"><span class="lab-cell-glyph">${player ? '◆' : enemy ? glyph(enemy) : '·'}</span>${enemy ? `<span class="lab-cell-hp">${enemy.hp}</span>${enemy.down || enemy.recovery ? `<span class="lab-cell-status">${enemy.down ? `↓${enemy.down}` : `r${enemy.recovery}`}</span>` : enemy.id === state.player.grabbedBy ? '<span class="lab-cell-status lab-grab-text">⊏</span>' : enemy.intent ? `<span class="lab-cell-status ${enemy.intent.kind === 'grab' ? 'lab-grab-text' : 'lab-alert'}">${enemy.intent.kind === 'grab' ? '⊏' : '!'}</span>` : ''}${comboHits ? `<span class="lab-cell-combo">${comboHits}/3</span>` : ''}<span class="lab-cell-health" style="--enemy-health:${Math.max(0, enemy.hp) / enemy.maxHp * 100}%"></span>` : ''}${player && held() ? '<span class="lab-cell-hold">HELD</span>' : ''}${attacks.has(cellKey) ? '<span class="lab-threat-mark" aria-hidden="true">⌜</span>' : ''}${grabCells.has(cellKey) ? '<span class="lab-grab-mark" aria-hidden="true">⊏</span>' : ''}</button>`);
    }
    root.classList.add('combat-lab');
    root.innerHTML = `<main class="lab-shell" data-testid="combat-lab" data-phase="${state.phase}" data-beat="${state.beat}">
      <header class="lab-header"><div><span class="lab-eyebrow">Final Fight RL / Combat prototype</span><h1>COMBAT <span>LAB</span></h1></div><div class="lab-header-note"><span>One arena · six enemies</span><span>Live experiment · no saves</span></div></header>
      <div class="lab-vitals" aria-label="Combat status"><div class="lab-health"><span>YOUR HP</span><strong data-testid="lab-player-hp">${state.player.hp}<small> / ${state.player.maxHp}</small></strong><i style="--health:${Math.max(0, state.player.hp) / state.player.maxHp * 100}%"></i></div><div><span>BEAT</span><strong data-testid="lab-beat">${String(state.beat).padStart(2, '0')}</strong></div><div><span>ENEMIES</span><strong>${living.length}<small> / 6</small></strong></div><div class="lab-vault-status"><span>VAULT</span><strong>${state.player.vaultCooldown ? `${state.player.vaultCooldown} beat${state.player.vaultCooldown === 1 ? '' : 's'}` : 'Ready'}</strong></div></div>
      ${held() ? `<div class="lab-grab-status" role="status" data-testid="lab-grab-status"><strong>GRABBED · ${escape(targetLabel(state.player.grabbedBy!))}</strong><span>Strike the grabber or Vault to escape. Step and Throw are locked.</span></div>` : ''}
      <div class="lab-workspace"><section class="lab-playfield" aria-label="Combat arena"><div class="lab-arena-heading"><p>Create an opening. <b>Finish the combo.</b></p><button type="button" data-command="inspect" class="lab-text-button ${inspectMode ? 'is-selected' : ''}" aria-pressed="${inspectMode}">Inspect <kbd>I</kbd></button></div><div class="lab-board" role="group" aria-label="9 by 7 arena, surrounded by walls" data-testid="lab-board">${cells.join('')}</div><div class="lab-legend"><span><b class="lab-player-letter">◆</b> You</span><span><b>B</b> Brawler</span><span><b class="lab-lunger-letter">L</b> Lunger</span><span><b class="lab-grappler-letter">G</b> Grappler</span><span><i class="lab-legend-threat"></i> Damage</span><span><i class="lab-legend-grab"></i> Grab</span><span><i class="lab-legend-landing"></i> Landing</span></div>
      ${terminalHtml()}<div class="lab-combo-strip" data-testid="lab-combo">${state.player.combo ? `<strong>COMBO ${state.player.combo.hits}/3</strong><span>${escape(targetLabel(state.player.combo.targetId))} · ${byId(state.player.combo.targetId)?.down ? 'Target down: 1 damage; combo paused' : state.player.combo.hits === 2 ? 'Next strike: 10 damage' : 'Next strike: 1 damage'}</span>` : '<strong>1 + 1 + 10</strong><span>Three consecutive strikes. One decisive finish.</span>'}</div><section class="lab-log" aria-label="Recent combat events"><span class="lab-eyebrow">Last exchange</span><ol>${state.log.length ? state.log.slice(-4).map(line => `<li>${escape(line)}</li>`).join('') : '<li>Six enemies surround you. Make some room.</li>'}</ol></section></section>
      <aside class="lab-controls" aria-label="Combat controls"><div class="lab-action-heading"><span class="lab-eyebrow">Your move</span><span>${held() ? 'Grabbed · escape first' : state.openingStepAvailable ? 'Step first → free move' : '1 action = 1 beat'}</span></div><div class="lab-actions">${ACTIONS.map((item, index) => `<button type="button" data-action="${item.name}" data-testid="lab-action-${item.name.toLowerCase()}" class="lab-action ${action === item.name ? 'is-selected' : ''}" aria-pressed="${action === item.name}" title="${escape(actionHint(item.name, item.hint))}" ${state.phase !== 'combat' || actionBlocked(item.name) ? 'disabled' : ''}><kbd>${index + 1}</kbd><span class="lab-action-icon" aria-hidden="true">${item.icon}</span><span><b>${item.name}</b><small>${escape(actionHint(item.name, item.hint))}</small></span>${item.name === 'Vault' && state.player.vaultCooldown ? `<em>${state.player.vaultCooldown}</em>` : ''}</button>`).join('')}</div><p class="lab-aim-hint" data-testid="lab-aim-hint">${escape(aimHint())}</p>${directionHtml()}<section class="lab-forecast" aria-label="Action forecast"><div class="lab-forecast-heading"><span class="lab-eyebrow">${action ? `${action} forecast` : 'Forecast'}</span><span>Before you commit</span></div><div data-testid="lab-preview">${previewHtml(forecast)}</div>${feedback ? `<p class="lab-invalid" role="status">${escape(feedback)}</p>` : ''}<div class="lab-confirm-row"><button type="button" class="lab-confirm" data-command="confirm" data-testid="lab-confirm" ${!forecast?.valid || state.phase !== 'combat' ? 'disabled' : ''}>Confirm${action ? ` ${action.toLowerCase()}` : ''}<kbd>↵</kbd></button><button type="button" class="lab-cancel" data-command="cancel" title="Cancel selection (Escape)" ${!action && !inspectMode ? 'disabled' : ''}>Cancel</button></div></section><section class="lab-inspection" aria-label="Selected cell" data-testid="lab-inspection">${inspectionHtml()}</section></aside></div>
      <details class="lab-help" ${helpOpen ? 'open' : ''}><summary>Controls &amp; combat rules <kbd>H</kbd></summary><div class="lab-help-content"><div><h2>Read. Disrupt. Finish.</h2><p><b>Step:</b> move to an adjacent empty cell. You can step diagonally past one occupied side cell, but cannot squeeze between two enemies.</p><p><b>Opening Step:</b> if your very first combat action is Step, move once without advancing the beat or the enemies, then act again. Any other first action gives up this free move. Vault is never free. Inspection, aiming, cancellation, and invalid actions do not spend the opening.</p><p><b>Strike:</b> standing targets take 1, 1, then 10 damage. Every strike interrupts the target for that beat. Another action, another target, taking damage, or being grabbed breaks your combo. Striking a downed target deals only 1 damage and cannot start or advance a combo; existing progress against that same target stays unchanged.</p><p><b>Throw:</b> send an adjacent enemy up to three cells and knock it down for this beat plus two more. The throw and its first body collision each deal 1 damage to standing enemies; already downed bodies take 0. You can still throw downed bodies, including into an immediately adjacent enemy without travel space. Both bodies fall down; walls stop throws. A grappler preparing a grab cannot be thrown directly.</p><p><b>Getting up:</b> ↓ counts beats until standing. On the beat a down counter reaches zero, the enemy stands and immediately prepares an attack from its cell if it can reach you and was not interrupted. It cannot hit you until your next action. There is no extra idle beat after standing.</p><p><b>Vault:</b> cross an adjacent enemy to the empty cell beyond. No damage, suppression, or invulnerability. Use three other actions before vaulting again. A legal Vault over any enemy also escapes a grab; its usual cooldown still applies.</p><p><b>Grapplers (G):</b> move up to two cells and prepare a grab for the next beat. Orange brackets show its committed target. Dodge it, interrupt with Strike, or hit the grappler with a thrown body. Throw cannot directly grab it while it prepares its own grab.</p><p><b>While grabbed:</b> Step and Throw are locked. Strike an adjacent enemy for 1 damage without combo progress; hitting your grabber frees you. Vault over any adjacent enemy to escape, or Wait. Taking damage also releases the hold. A grab itself deals no damage, but other enemies can still hit you.</p><p><b>Enemy attacks:</b> red cells are fixed. A dodged brawler stays put. A dodged lunger still advances to its planned landing cell, just before its original target, stopping early at a body. A miss has <em>no recovery</em>; a hit requires one recovery beat. Brawlers and lungers do not retarget or prepare another attack that turn. A missed grab also spends its turn without recovery. ↓ shows beats until standing; r shows recovery.</p></div><div><h2>Every decision is yours</h2><p><b>Mouse / touch:</b> choose an action, choose a cell or enemy, then confirm. For a throw, select an enemy then a compass direction. Inspection and aiming are free.</p><p><b>1–5:</b> select Step, Strike, Throw, Vault, or Wait. <b>Enter:</b> confirm. <b>Escape:</b> cancel. <b>I:</b> toggle inspection. <b>H:</b> show this help.</p><p><b>Q W E / A · D / Z X C:</b> eight directions. With no action selected, these and the arrow keys move immediately; <b>S</b> waits immediately. With an action selected, directions aim it. With Throw selected, first aim at an enemy, then aim its throw.</p><p>The fixed encounter has two brawlers, two lungers, and two grapplers, each with 12 HP. Clear the arena to win. This encounter is repeatable and does not save.</p></div></div></details><p class="lab-bottom-note">Control the crowd, one beat at a time.</p><div class="lab-sr-only" role="status" aria-live="polite" aria-atomic="true">Beat ${state.beat}. Health ${state.player.hp}. ${escape(feedback || state.log.at(-1) || aimHint())}</div>
    </main>`;
    if (focusKey) root.querySelector<HTMLElement>(focusKey)?.focus({ preventScroll: true });
  }
  function click(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button') : null;
    if (!target || !root.contains(target) || target.hasAttribute('disabled')) return;
    if (target.dataset.action) { setAction(target.dataset.action as Action); return; }
    if (target.dataset.direction !== undefined) { chooseDirection(DIRS[Number(target.dataset.direction)]); return; }
    if (target.dataset.cell) { const [x, y] = target.dataset.cell.split(',').map(Number); chooseCell({ x, y }); return; }
    switch (target.dataset.command) {
      case 'confirm': commit(); break;
      case 'cancel': clearSelection(); break;
      case 'retarget': command = null; throwTarget = null; render(); break;
      case 'inspect': inspectMode = !inspectMode; feedback = ''; render(); break;
      case 'restart': state = createEncounter(); inspected = null; inspectedEnemyId = null; hovered = null; clearSelection(); break;
    }
  }
  function keydown(event: KeyboardEvent): void {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || destroyed) return;
    if (event.target instanceof HTMLElement && (event.target.matches('input, textarea, select') || event.target.isContentEditable)) return;
    const pressed = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (pressed === 'h') { event.preventDefault(); helpOpen = !helpOpen; render(); return; }
    if (pressed === 'i') { event.preventDefault(); inspectMode = !inspectMode; feedback = ''; render(); return; }
    if (pressed === 'Escape') { event.preventDefault(); clearSelection(); return; }
    if (state.phase !== 'combat') return;
    if (/^[1-5]$/.test(pressed)) { event.preventDefault(); setAction(ACTIONS[Number(pressed) - 1].name); return; }
    if (pressed === 'Enter' && command) { event.preventDefault(); commit(); return; }
    if (DIRECTION_KEYS[pressed]) { event.preventDefault(); chooseDirection(DIRECTION_KEYS[pressed]); return; }
    if (pressed === 's') { event.preventDefault(); if (!action && !inspectMode) commit({ type: 'Wait' }); else if (!inspectMode) setAction('Wait'); }
  }
  function toggle(event: Event): void { if (event.target instanceof HTMLDetailsElement && event.target.classList.contains('lab-help')) helpOpen = event.target.open; }
  function refreshInspection(): void {
    const panel = root.querySelector<HTMLElement>('[data-testid="lab-inspection"]');
    if (panel) panel.innerHTML = inspectionHtml();
  }
  function pointerover(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    const cell = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-cell]') : null;
    if (!cell?.dataset.cell || !root.contains(cell)) return;
    const [x, y] = cell.dataset.cell.split(',').map(Number);
    hovered = { x, y }; refreshInspection();
  }
  function pointerout(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    const nextCell = event.relatedTarget instanceof Element ? event.relatedTarget.closest('[data-cell]') : null;
    if (nextCell && root.contains(nextCell)) return;
    if (hovered) { hovered = null; refreshInspection(); }
  }
  root.addEventListener('click', click);
  root.addEventListener('toggle', toggle, true);
  root.addEventListener('pointerover', pointerover);
  root.addEventListener('pointerout', pointerout);
  window.addEventListener('keydown', keydown);
  render();
  return { render, destroy() { destroyed = true; root.removeEventListener('click', click); root.removeEventListener('toggle', toggle, true); root.removeEventListener('pointerover', pointerover); root.removeEventListener('pointerout', pointerout); window.removeEventListener('keydown', keydown); root.classList.remove('combat-lab'); root.replaceChildren(); } };
}
