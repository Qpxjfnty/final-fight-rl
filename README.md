# Final Fight RL — Combat Prototype

A small, turn-based browser game about managing a surrounding crowd and creating an opening for a three-hit combo.

**[Play the demo](https://qpxjfnty.github.io/final-fight-rl/)**

The demo runs entirely in the browser on desktop or tablet. No installation, account, or running development computer is needed. A refresh starts a fresh encounter; there are no saves or cross-device state.

## The fight

Six enemies surround you in a 9×7 arena. You have 24 HP; each enemy has 12 HP. Your five actions are **Step, Strike, Throw, Vault, and Wait**. One valid action normally advances one beat. If your **very first combat action is Step**, that one move is free: enemies wait, the beat and timers stay unchanged, and you act again. Any other first action gives up this opening move; Vault is never free. Inspection, targeting, cancellation, and invalid actions are free and do not spend the opening.

- **Strike:** hit and interrupt one adjacent enemy. Three consecutive strikes against the same target deal **1 + 1 + 10 damage**, defeating a fresh enemy. Changing target or action, or taking damage, breaks the combo.
- **Throw:** choose an adjacent enemy and a direction. Throw it up to three cells for 1 damage. A collision deals 1 damage to the first enemy hit; both enemies are knocked down for the throw beat and two further beats. The throw stops before a wall or body and requires an empty landing cell.
- **Vault:** cross an adjacent enemy to the empty cell behind it. Deals no damage and becomes available again after three other actions. It does not protect you from an attack aimed at the landing cell.
- **Step:** move to an adjacent empty cell in any of eight directions. A diagonal step can pass one occupied side cell, but cannot squeeze between two enemies.
- **Wait:** spend one beat in place.

Brawlers threaten adjacent cells; lungers threaten straight paths from farther away. Red cells show attacks committed for the next beat. If you dodge a brawler's committed attack, it **cancels and stays put without recovery**. A lunger still advances along its committed path to its original landing cell—the cell before its original target—even if you dodge. Bodies stop its advance early. If it cannot hit you, it has **no recovery**. Neither enemy retargets or prepares another attack that turn; both can act on the following beat. An attack that hits requires a recovery beat.

The forecast shows player movement, throws, lunger landing cells, damage, interrupts, knockdowns, missed or cancelled attacks, and incoming damage before you confirm. Clear the arena to win; defeat or victory offers a restart of the same encounter. Balance remains provisional.

## Controls

**Mouse or touch:** choose an action, choose its target, and Confirm. Throw also needs a direction. Click or tap a cell with no action selected to inspect it; hovering inspects without changing your aim.

**Keyboard:** 1–5 select Step, Strike, Throw, Vault, and Wait. Use **Q W E / A · D / Z X C** for eight directions; arrows also work. With no action selected, direction keys move immediately and **S** waits. With an action selected, direction keys aim; **Enter** confirms. **Escape** cancels, **I** toggles inspection, and **H** opens help. For throws, first choose the enemy's direction, then the throw direction.

## Develop locally

Use Node.js 24 (also recorded in `.nvmrc`) and npm:

```sh
npm ci
npm run dev
```

Open the address printed by Vite, normally `http://127.0.0.1:5173/`. On macOS, **Start Final Fight RL.command** launches the game. **Start iPad Playtest.command**, or `npm run ipad`, serves a local Wi-Fi preview on port 5174; this local preview requires the Mac to remain running. The hosted demo does not.

```sh
npm run check       # Combat tests, TypeScript checks, and production build
npm run simulate    # Bounded tactical-search feasibility probe
npm run analyze     # Generate analysis rooms and record winning action sequences
npm run preview     # Serve the built dist/ locally
```

The combat tests cover the one-time free opening Step, timing, dodged lunges, cancellation without recovery, combo breaks, throw collisions, vault cooldowns, deterministic previews, and state invariants. The simulation searches for a winning tactical sequence and writes ignored evidence to `work/qa/combat-lab/`. It checks feasibility, not human difficulty or enjoyment.

## Combo viability and winning-sequence analysis

The playable demo currently uses one fixed encounter. `npm run simulate` searches for one winning line; it does not prove that every possible room is winnable. The separate analysis tool tests that encounter plus reproducible generated enemy placements, keeping the same arena, health, enemy mix, and combat rules. A room **passes** when at least one replayed win gets **more than 50% of actual enemy HP removed from combo finishers**. Chip-damage wins are allowed; the concern is a room that lacks a viable combo-focused route.

```sh
npm run analyze
npm run analyze -- --rooms 8 --seed 42 --max-beats 40 --beam-width 128
npm run analyze -- --objective balanced --rooms 0 --max-beats 96 --max-transitions 150000
npm run analyze -- --mode exhaustive --rooms 0 --max-beats 4 --max-transitions 100000
npm run analyze -- --help
```

The default searches the fixed demo plus four generated rooms, using seeds 1–4, a 40-action horizon, a beam width of 96, and a budget of 75,000 simulated actions per room. Each generated room starts with six enemies surrounding the player, at distances of two to three cells. This generator belongs to the analysis tooling; it does not replace the live demo's layout.

Each run creates a new directory under `work/qa/combat-analysis/` with:

- `wins.csv`: one row per discovered win, with room, win number, total actions, elapsed combat beats, remaining HP, separate **Step / Strike / Throw / Vault / Wait** counts (including a free opening Step, if used), completed/broken combos, finisher kills, and effective damage from finishers, ordinary strikes, and throws. It also records the finisher damage share and whether the win qualifies. The search horizon counts player actions, including the free Step; the existing `--max-beats` option retains its name for compatibility.
- `winning-sequences.jsonl`: the full command sequence for every CSV row, including targets and throw directions. Every win is replayed through the game engine before recording.
- `rooms.json`: exact initial states for reproduction.
- `report.md` and `summary.json`: each room's combo viability result, a qualifying witness when found, coverage, search limits, action-count ranges and averages, damage statistics, and action-usage profiles.

**Exhaustive mode** explores every legal sequence up to the action limit, including distinct paths that reach the same state. It stops a sequence when the fight ends. Completion is reported only if the whole bounded search finishes before its transition budget. With movement and waiting, sequences can loop; enumerating all lengths is not a finite practical test. Even a finite horizon grows rapidly with each added turn.

**Sampled mode** keeps promising paths at each depth and continues looking after the first win. Its default `combo` objective deliberately favors combo opportunities to find a qualifying witness. The optional `balanced` objective prioritizes damage, kills, and survival without bonuses for combo progress or finisher kills. Both are deterministic, heuristic samples, never exhaustive censuses. Action frequencies describe the found sequences, not human behavior, action necessity, or the distribution of all possible wins. The objective does not affect exhaustive enumeration.

A qualifying replayed win establishes **pass** for that room, even when other sequences win entirely through chip damage. Only nonqualifying wins in a partial search means **needs review**; no wins means **inconclusive**. A completed exhaustive search without a qualifying win means **no combo win within the chosen horizon**, not impossibility at every length. Damage uses actual HP removed, so a 10-damage finisher against 1 HP contributes only 1. These checks do not establish that every possible generated room supports combos; a future runtime generator should retain a verified qualifying witness or retry unresolved rooms.

The command exits with code 2 if any tested room lacks a qualifying witness, after saving its report. This is a review gate, not a claim of impossibility. GitHub's workflow runs the default demo plus seeds 1–4 on each push and pull request and saves the results in its `combat-analysis` artifact. An unresolved room stops deployment until investigated.

## Project structure

- `src/model.ts`: state, commands, and balance values.
- `src/engine.ts`: pure encounter creation, previews, turn resolution, and enemy behavior.
- `src/ui.ts`, `src/style.css`: controls, arena, forecasts, and responsive presentation.
- `tests/combat.test.ts`: the prototype's rules and tactical scenarios.
- `scripts/`: local tablet preview and repeatable simulation.

This repository contains only the combat prototype. The earlier game is preserved in the original development checkout's local `archive/pre-consolidation` tag and `legacy-local` branch, outside this repository's published history. Features can be brought back deliberately later.

## Publishing

GitHub Pages uses the **Check and deploy demo** workflow. Every push to `main` runs `npm ci`, tests, TypeScript checks, a build, and combo-viability analysis, then publishes only `dist/`. Pull requests run the checks without deploying. Failed checks leave the previous demo in place. The workflow can also be run manually from Actions.

Assets use relative URLs so the build works at the repository's Pages path as well as locally. For a fork, enable **Settings → Pages → Source: GitHub Actions** and update the demo link above. No repository secrets or backend services are required.
