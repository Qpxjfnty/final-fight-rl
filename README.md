# Final Fight RL — Combat Prototype

A small, turn-based browser game about managing a surrounding crowd and creating an opening for a three-hit combo.

**[Play the demo](https://qpxjfnty.github.io/final-fight-rl/)**

The demo runs entirely in the browser on desktop or tablet. No installation, account, or running development computer is needed. A refresh starts a fresh encounter; there are no saves or cross-device state.

## The fight

Six enemies surround you in a 9×7 arena. You have 24 HP; each enemy has 12 HP. Your five actions are **Step, Strike, Throw, Vault, and Wait**. One valid action advances one beat. Inspection, targeting, cancellation, and invalid actions are free.

- **Strike:** hit and interrupt one adjacent enemy. Three consecutive strikes against the same target deal **1 + 1 + 10 damage**, defeating a fresh enemy. Changing target or action, or taking damage, breaks the combo.
- **Throw:** choose an adjacent enemy and a direction. Throw it up to three cells for 1 damage. A collision deals 1 damage to the first enemy hit; both enemies are knocked down for the throw beat and two further beats. The throw stops before a wall or body and requires an empty landing cell.
- **Vault:** cross an adjacent enemy to the empty cell behind it. Deals no damage and becomes available again after three other actions. It does not protect you from an attack aimed at the landing cell.
- **Step:** move to an adjacent empty cell in any of eight directions. You cannot cut diagonally through occupied corners.
- **Wait:** spend one beat in place.

Brawlers threaten adjacent cells; lungers threaten straight paths from farther away. Red cells show attacks committed for the next beat. If you leave an attack's committed cells, the enemy **cancels and skips that turn without recovery**. It does not move, retarget, or prepare another attack that turn. Lungers also cancel when a body blocks their path. An attack that fires requires a recovery beat.

The forecast shows movement, damage, interrupts, knockdowns, cancelled attacks, and incoming damage before you confirm. Clear the arena to win; defeat or victory offers a restart of the same encounter. Balance remains provisional.

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
npm run preview     # Serve the built dist/ locally
```

The 25 combat tests cover timing, cancellation without recovery, combo breaks, throw collisions, vault cooldowns, deterministic previews, and state invariants. The simulation writes ignored evidence to `work/qa/combat-lab/`. Its current winning line uses 30 beats, ends at 17 HP, and finishes all six enemies with combos. It checks feasibility, not human difficulty or enjoyment.

## Project structure

- `src/model.ts`: state, commands, and balance values.
- `src/engine.ts`: pure encounter creation, previews, turn resolution, and enemy behavior.
- `src/ui.ts`, `src/style.css`: controls, arena, forecasts, and responsive presentation.
- `tests/combat.test.ts`: the prototype's rules and tactical scenarios.
- `scripts/`: local tablet preview and repeatable simulation.

This repository contains only the combat prototype. The earlier game is preserved in the original development checkout's local `archive/pre-consolidation` tag and `legacy-local` branch, outside this repository's published history. Features can be brought back deliberately later.

## Publishing

GitHub Pages uses the **Check and deploy demo** workflow. Every push to `main` runs `npm ci`, tests, TypeScript checks, and a build, then publishes only `dist/`. Pull requests run the checks without deploying. A failed build leaves the previous demo in place. The workflow can also be run manually from Actions.

Assets use relative URLs so the build works at the repository's Pages path as well as locally. For a fork, enable **Settings → Pages → Source: GitHub Actions** and update the demo link above. No repository secrets or backend services are required.
