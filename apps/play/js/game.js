// Being in a room: keys become input messages, snapshots are buffered and drawn every
// animation frame a little in the past, and the side panel shows the score and roster.
// The player can hand their explorer to their agent (keys are then ignored until they take
// it back), teach that agent from their own play while they drive, and turn on the heatmap
// cheat.
//
// Score is each explorer's credit: the expected number of events its looking resolved,
// the same quantity the guard agents are trained to maximise (minus energy).

import { DIRECTIONS } from '@pixel-map-lab/core';
import { RoomView } from './render.js';
import { SnapshotBuffer } from './snapshots.js';
import { Intent } from './input.js';

const GAIT_NAMES = { walk: 'Walking', run: 'Running', sprint: 'Sprinting' };

/** Format a credit (expected events resolved) for display. */
const score = credit => (credit * 1000).toFixed(1);

export class Game {
  /**
   * connection: { send(message) }; elements: the room view's DOM nodes; selfId: this
   * player's id; signedIn: whether their agents are kept; joined: the server's 'joined'
   * message; autopilot: whether the server offers the autopilot.
   */
  constructor({ connection, elements, selfId, signedIn = false, joined, autopilot }) {
    this.connection = connection;
    this.elements = elements;
    this.selfId = selfId;
    this.view = new RoomView(elements.canvas, joined.map);
    this.snapshots = new SnapshotBuffer();
    this.intent = new Intent();
    this.autopilot = joined.you.autopilot;
    this.taught = joined.you.agent;
    this.signedIn = signedIn;
    this.frame = 0;
    elements.title.textContent = joined.room.planName;
    elements.code.textContent = joined.room.id;

    // Keys always update the intent, but only reach the server while the player is driving.
    const sendIntent = () => {
      if (!this.autopilot) connection.send(this.intent.message());
    };
    this.onKeyDown = event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.target.matches('input, textarea, select')) return;
      const change = this.intent.press(event.key);
      if (!change) return;
      event.preventDefault();
      if (change === 'sit' && !event.repeat && !this.autopilot) connection.send({ type: 'sit' });
      if (change === 'input') sendIntent();
    };
    this.onKeyUp = event => {
      if (this.intent.release(event.key)) sendIntent();
    };
    this.onBlur = () => {
      if (this.intent.releaseAll()) sendIntent();
    };

    elements.autopilot.hidden = !autopilot;
    elements.autopilotNote.hidden = autopilot;
    elements.agentPanel.hidden = !autopilot;
    elements.agentMap.textContent = `on ${joined.room.planName}`;
    elements.tuning.checked = joined.you.tuning;
    elements.tuning.onchange = () => {
      connection.send({ type: 'tuning', on: elements.tuning.checked });
      this.showAgent();
      elements.canvas.focus();
    };
    elements.resetAgent.onclick = () => {
      connection.send({ type: 'resetAgent' });
      elements.canvas.focus();
    };
    this.showAutopilot();
    elements.autopilot.onclick = () => {
      this.autopilot = !this.autopilot;
      connection.send({ type: 'autopilot', on: this.autopilot });
      // Taking control back: carry on with whatever keys are held now.
      if (!this.autopilot) connection.send(this.intent.message());
      this.showAutopilot();
      elements.canvas.focus();
    };
    // The heatmap choice belongs to the session, so it carries over from room to room.
    elements.heatmap.onchange = () => {
      connection.send({ type: 'heatmap', on: elements.heatmap.checked });
      if (!elements.heatmap.checked) this.view.setHeat(null);
      elements.canvas.focus();
    };
    if (elements.heatmap.checked) connection.send({ type: 'heatmap', on: true });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onBlur);
    elements.canvas.focus();
    this.loop = this.loop.bind(this);
    this.frame = requestAnimationFrame(this.loop);
  }

  onState(snapshot) {
    this.snapshots.push(snapshot, performance.now());
    this.showPanel(snapshot);
  }

  onHeat(message) {
    if (this.elements.heatmap.checked) this.view.setHeat(message);
  }

  onTuning(status) {
    this.taught = status;
    this.showAgent();
  }

  showAutopilot() {
    const { autopilot, leave, tuning } = this.elements;
    autopilot.textContent = this.autopilot ? 'Take back control' : 'Let your agent drive';
    autopilot.setAttribute('aria-pressed', this.autopilot);
    autopilot.classList.toggle('outline', !this.autopilot);
    leave.textContent = this.autopilot ? 'Leave, agent stays' : 'Leave';
    // Teaching happens only while the player drives.
    tuning.disabled = this.autopilot;
    tuning.parentElement.title = this.autopilot ? 'Take back control to teach your agent' : '';
    this.showAgent();
  }

  /** Say which agent drives for this player, how far it has been taught and trained, and whether it is kept. */
  showAgent() {
    const { demos, updates, version = 0, trained, job } = this.taught;
    const learning = this.elements.tuning.checked && !this.autopilot;
    const live = demos ? `Learned live from ${demos} moment${demos === 1 ? '' : 's'} of your play (${updates} steps)` : '';
    this.elements.agentStatus.textContent = version
      ? `Trained version ${version}${live ? ` · ${live.toLowerCase()}` : ''}${learning ? ' · learning now' : ''}.`
      : live ? `${live}${learning ? ' · learning now' : ''}.` : learning ? 'Learning from your play…' : 'Pretrained: teach it by playing with fine-tuning on.';
    this.elements.agentKept.textContent = this.signedIn ? keptNote(trained, job) : 'Sign in to keep your agent and train it fully between visits.';
  }

  loop(now) {
    const latest = this.snapshots.latest;
    if (latest) {
      const self = latest.explorers.find(explorer => explorer.id === this.selfId);
      const floor = self ? self.floor : 0;
      this.view.draw({ explorers: this.snapshots.explorersAt(now), floor, openDoors: latest.doors, spots: latest.spots, selfId: this.selfId });
      this.elements.floor.textContent = this.view.map.floors[floor].name;
    }
    this.frame = requestAnimationFrame(this.loop);
  }

  showPanel(snapshot) {
    const { elements } = this;
    const self = snapshot.explorers.find(explorer => explorer.id === this.selfId);
    const team = snapshot.explorers.reduce((sum, explorer) => sum + explorer.credit, 0);
    if (self) {
      elements.score.textContent = score(self.credit);
      elements.kcal.textContent = self.kcal.toFixed(1);
      elements.pose.textContent = `${self.sitting ? 'Sitting' : GAIT_NAMES[self.gait]} · facing ${DIRECTIONS[self.facing]}`;
    }
    elements.team.textContent = score(team);
    elements.unspotted.textContent = snapshot.psum.toFixed(3);
    elements.spotted.textContent = snapshot.spotted;
    elements.time.textContent = formatTime(snapshot.time);
    const rows = [...snapshot.explorers].sort((a, b) => b.credit - a.credit).map(explorer => {
      const row = document.createElement('li');
      const swatch = document.createElement('i');
      swatch.style.background = this.view.colorFor(explorer.id);
      const name = document.createElement('span');
      name.textContent = explorer.id === this.selfId ? `${explorer.name} (you)` : explorer.name;
      if (explorer.autopilot) {
        const badge = document.createElement('em');
        badge.textContent = explorer.away ? 'agent · away' : 'agent';
        name.append(' ', badge);
      }
      const where = document.createElement('small');
      where.textContent = this.view.map.floors[explorer.floor].name;
      const points = document.createElement('b');
      points.textContent = score(explorer.credit);
      row.append(swatch, name, where, points);
      return row;
    });
    elements.roster.replaceChildren(...rows);
  }

  stop() {
    cancelAnimationFrame(this.frame);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onBlur);
  }
}

/** What has happened to a kept agent: its last training job's results, and the next one. */
function keptNote(trained, job) {
  const parts = ['Saved to your account.'];
  if (trained) {
    const agreement = trained.agreement_after == null ? '' : `copies you ${Math.round(100 * trained.agreement_after)}% of the time`;
    const change = trained.cost_before ? Math.round(100 * (trained.cost_after / trained.cost_before - 1)) : null;
    const cost = change == null ? '' : `scores ${change <= 0 ? `${-change}% better` : `${change}% worse`} than before`;
    parts.push(`Last training: ${[agreement, cost].filter(Boolean).join(', ')}.`);
  }
  if (job?.status === 'queued') {
    const wait = Math.max(0, Math.round((new Date(job.not_before) - Date.now()) / 60000));
    parts.push(wait ? `Full training queued (in about ${wait} min).` : 'Full training queued.');
  } else if (job?.status === 'running') {
    parts.push('Full training under way…');
  }
  return parts.join(' ');
}

function formatTime(seconds) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
