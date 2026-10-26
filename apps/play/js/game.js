// Being in a room: keys become input messages, snapshots are buffered and drawn every
// animation frame a little in the past, and the side panel shows the score and roster.
// The player can turn on the heatmap cheat.
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
   * session's id; joined: the server's 'joined' message.
   */
  constructor({ connection, elements, selfId, joined }) {
    this.connection = connection;
    this.elements = elements;
    this.selfId = selfId;
    this.view = new RoomView(elements.canvas, joined.map);
    this.snapshots = new SnapshotBuffer();
    this.intent = new Intent();
    this.frame = 0;
    elements.title.textContent = joined.room.planName;
    elements.code.textContent = joined.room.id;

    this.onKeyDown = event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.target.matches('input, textarea, select')) return;
      const change = this.intent.press(event.key);
      if (!change) return;
      event.preventDefault();
      if (change === 'sit' && !event.repeat) connection.send({ type: 'sit' });
      if (change === 'input') connection.send(this.intent.message());
    };
    this.onKeyUp = event => {
      if (this.intent.release(event.key)) connection.send(this.intent.message());
    };
    this.onBlur = () => {
      if (this.intent.releaseAll()) connection.send(this.intent.message());
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

function formatTime(seconds) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
