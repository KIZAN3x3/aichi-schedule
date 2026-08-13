import { colorForCategory, DEFAULT_CATEGORY_COLOR } from './categories.js';

const START_HOUR = 0;
const END_HOUR = 24;
const HOUR_HEIGHT = 96; // px（10分刻み表示のため1時間あたりの高さを拡大）
const SLOT_MINUTES = 10; // 目盛りの刻み
const NO_END_DURATION_MINUTES = 30; // 終了時間未入力イベントの固定ブロック幅
const MIN_DURATION_MINUTES = 10; // 極端に短いブロックでも視認できる最低の高さ（10分刻みに合わせる）
const MIN_BLOCK_HEIGHT_PX = 22; // どんなに短くても最低これだけの高さは確保する
const COMPACT_HEIGHT_PX = 34; // これ未満は時刻+場所を1行にまとめる
const CONTENT_HEIGHT_PX = 52; // これ未満は活動内容を省略する

function toMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function formatHm(timeStr) {
  return timeStr.slice(0, 5);
}

// 開始時刻順に並べ、重なりのある予定を連結グループにまとめたうえで
// 各グループ内で貪欲法により列(column)を割り当てる（区間グラフの貪欲彩色は最小列数になる）
function computeBlocks(events) {
  const items = events
    .map((event) => {
      const start = toMinutes(formatHm(event.time));
      let end = event.end_time ? toMinutes(formatHm(event.end_time)) : start + NO_END_DURATION_MINUTES;
      if (end - start < MIN_DURATION_MINUTES) end = start + MIN_DURATION_MINUTES;
      return { event, start, end, column: 0, columnCount: 1 };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const groups = [];
  let currentGroup = [];
  let currentGroupEnd = -Infinity;
  for (const item of items) {
    if (currentGroup.length > 0 && item.start >= currentGroupEnd) {
      groups.push(currentGroup);
      currentGroup = [];
      currentGroupEnd = -Infinity;
    }
    currentGroup.push(item);
    currentGroupEnd = Math.max(currentGroupEnd, item.end);
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  const blocks = [];
  for (const group of groups) {
    const columnEnds = [];
    for (const item of group) {
      let columnIndex = columnEnds.findIndex((end) => end <= item.start);
      if (columnIndex === -1) {
        columnIndex = columnEnds.length;
        columnEnds.push(item.end);
      } else {
        columnEnds[columnIndex] = item.end;
      }
      item.column = columnIndex;
    }
    const columnCount = columnEnds.length;
    for (const item of group) {
      item.columnCount = columnCount;
      blocks.push(item);
    }
  }
  return blocks;
}

export function renderTimeline(container, events) {
  container.innerHTML = '';

  const totalHeight = (END_HOUR - START_HOUR) * HOUR_HEIGHT;

  const scroll = document.createElement('div');
  scroll.className = 'timeline-scroll';

  const inner = document.createElement('div');
  inner.className = 'timeline-inner';
  inner.style.height = `${totalHeight}px`;

  const labels = document.createElement('div');
  labels.className = 'timeline-labels';

  const track = document.createElement('div');
  track.className = 'timeline-track';

  const startMinutes = START_HOUR * 60;
  const endMinutes = END_HOUR * 60;
  for (let minutes = startMinutes; minutes < endMinutes; minutes += SLOT_MINUTES) {
    const top = ((minutes - startMinutes) / 60) * HOUR_HEIGHT;
    const isHourMark = minutes % 60 === 0;
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;

    const label = document.createElement('div');
    label.className = isHourMark ? 'timeline-hour-label' : 'timeline-minute-label';
    label.style.top = `${top}px`;
    label.textContent = isHourMark ? `${hour}:00` : `:${String(minute).padStart(2, '0')}`;
    labels.appendChild(label);

    const line = document.createElement('div');
    line.className = isHourMark ? 'timeline-hour-line' : 'timeline-minute-line';
    line.style.top = `${top}px`;
    track.appendChild(line);
  }

  const blocks = computeBlocks(events);
  for (const block of blocks) {
    track.appendChild(createTimelineBlock(block));
  }

  inner.appendChild(labels);
  inner.appendChild(track);
  scroll.appendChild(inner);
  container.appendChild(scroll);

  scrollToFirstBlock(scroll, blocks);
}

function createTimelineBlock({ event, start, end, column, columnCount }) {
  const el = document.createElement('div');
  el.className = 'timeline-block';
  const heightPx = Math.max(((end - start) / 60) * HOUR_HEIGHT - 2, MIN_BLOCK_HEIGHT_PX);
  el.style.top = `${((start - START_HOUR * 60) / 60) * HOUR_HEIGHT}px`;
  el.style.height = `${heightPx}px`;
  el.style.left = `calc(${(column / columnCount) * 100}% + 2px)`;
  el.style.width = `calc(${100 / columnCount}% - 4px)`;
  el.style.backgroundColor = event.category ? colorForCategory(event.category) : DEFAULT_CATEGORY_COLOR;

  const startLabel = formatHm(event.time);
  const endLabel = event.end_time ? formatHm(event.end_time) : '';
  const timeText = endLabel ? `${startLabel}–${endLabel}` : startLabel;
  el.title = `${startLabel}${endLabel ? '〜' + endLabel : ''} ${event.place}\n${event.content}`;

  if (heightPx < COMPACT_HEIGHT_PX) {
    el.classList.add('timeline-block-compact');
    const line = document.createElement('div');
    line.className = 'timeline-block-line';
    line.textContent = `${timeText} ${event.place}`;
    el.appendChild(line);
    return el;
  }

  const timeLabel = document.createElement('div');
  timeLabel.className = 'timeline-block-time';
  timeLabel.textContent = timeText;

  const placeLabel = document.createElement('div');
  placeLabel.className = 'timeline-block-place';
  placeLabel.textContent = event.place;

  el.appendChild(timeLabel);
  el.appendChild(placeLabel);

  if (heightPx >= CONTENT_HEIGHT_PX) {
    const contentLabel = document.createElement('div');
    contentLabel.className = 'timeline-block-content';
    contentLabel.textContent = event.content;
    el.appendChild(contentLabel);
  }

  return el;
}

function scrollToFirstBlock(scrollEl, blocks) {
  if (blocks.length === 0) return;
  const earliest = Math.min(...blocks.map((b) => b.start));
  const target = Math.max(0, ((earliest - START_HOUR * 60) / 60) * HOUR_HEIGHT - HOUR_HEIGHT);
  scrollEl.scrollTop = target;
}
