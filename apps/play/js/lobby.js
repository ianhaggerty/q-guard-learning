// The lobby: the maps a room can be started from, and the rooms already running.

/** A list item with a title, a detail line and one button. */
function item(title, detail, label, onClick, disabled = false) {
  const row = document.createElement('li');
  const text = document.createElement('div');
  const heading = document.createElement('strong');
  heading.textContent = title;
  const small = document.createElement('small');
  small.textContent = detail;
  text.append(heading, small);
  const button = document.createElement('button');
  button.className = 'button outline';
  button.textContent = label;
  button.disabled = disabled;
  button.onclick = onClick;
  row.append(text, button);
  return row;
}

export function showPlans(list, plans, onCreate) {
  list.replaceChildren(...plans.map(plan => item(plan.name, `Map ${plan.id}`, 'Start room', () => onCreate(plan.id))));
}

export function showRooms(list, empty, rooms, onJoin) {
  const newest = [...rooms].sort((a, b) => b.createdAt - a.createdAt);
  list.replaceChildren(...newest.map(room => item(
    room.planName,
    `Room ${room.id} · ${room.humans} of ${room.maxHumans} playing`,
    room.humans >= room.maxHumans ? 'Full' : 'Join',
    () => onJoin(room.id),
    room.humans >= room.maxHumans,
  )));
  empty.hidden = rooms.length > 0;
}
