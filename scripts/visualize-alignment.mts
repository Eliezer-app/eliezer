import { config } from 'dotenv'; config();
import Database from 'better-sqlite3';
import { Memory } from '../memory.mts';

const db = new Database(process.env.DB_PATH as string);
const memory = new Memory(db, process.env.USER_TZ as string);
const allGroups = memory.getUncompressedGroups(60);
const groups = allGroups.slice(0, -1);

// LLM output timestamps from the structured compaction run
const entries = [
  {time:'2026-02-06T07:18',role:'user'},
  {time:'2026-02-06T07:18',role:'agent'},
  {time:'2026-02-06T07:21',role:'user'},
  {time:'2026-02-06T07:21',role:'agent'},
  {time:'2026-02-06T07:29',role:'user'},
  {time:'2026-02-06T07:29',role:'agent'},
  {time:'2026-02-06T07:34',role:'user'},
  {time:'2026-02-06T07:34',role:'agent'},
  {time:'2026-02-06T07:43',role:'user'},
  {time:'2026-02-06T07:43',role:'agent'},
  {time:'2026-02-06T07:46',role:'user'},
  {time:'2026-02-06T07:46',role:'agent'},
  {time:'2026-02-06T08:23',role:'user'},
  {time:'2026-02-06T08:23',role:'agent'},
  {time:'2026-02-06T08:37',role:'user'},
  {time:'2026-02-06T08:37',role:'agent'},
  {time:'2026-02-06T08:41',role:'user'},
  {time:'2026-02-06T08:45',role:'user'},
  {time:'2026-02-06T08:45',role:'agent'},
  {time:'2026-02-06T09:12',role:'user'},
  {time:'2026-02-06T09:12',role:'agent'},
  {time:'2026-02-07T10:36',role:'user'},
  {time:'2026-02-07T10:58',role:'user'},
  {time:'2026-02-07T10:58',role:'agent'},
  {time:'2026-02-07T23:31',role:'user'},
  {time:'2026-02-07T23:31',role:'agent'},
  {time:'2026-02-08T19:07',role:'user'},
  {time:'2026-02-08T19:07',role:'agent'},
  {time:'2026-02-08T19:13',role:'user'},
  {time:'2026-02-08T19:23',role:'user'},
  {time:'2026-02-08T19:30',role:'agent'},
  {time:'2026-02-08T20:04',role:'user'},
  {time:'2026-02-08T20:04',role:'agent'},
  {time:'2026-02-08T21:52',role:'user'},
  {time:'2026-02-08T21:52',role:'agent'},
  {time:'2026-02-09T03:38',role:'user'},
  {time:'2026-02-09T03:38',role:'agent'},
  {time:'2026-02-09T03:43',role:'user'},
  {time:'2026-02-09T03:44',role:'agent'},
  {time:'2026-02-09T03:52',role:'user'},
  {time:'2026-02-09T03:57',role:'user'},
  {time:'2026-02-09T04:01',role:'agent'},
  {time:'2026-02-09T04:04',role:'user'},
  {time:'2026-02-09T04:05',role:'agent'},
];

// Build timeline events
const allEvents: Array<{time: number; type: 'group'|'llm'; label: string}> = [];

for (let i = 0; i < groups.length; i++) {
  const g = groups[i];
  const t = g.messages[0].created_at;
  allEvents.push({time: t, type: 'group', label: 'G' + String(i).padStart(2, '0')});
}

for (const e of entries) {
  const t = Math.floor(new Date(e.time + ':00Z').getTime() / 1000);
  allEvents.push({time: t, type: 'llm', label: e.role === 'user' ? 'U' : 'A'});
}

allEvents.sort((a, b) => a.time - b.time || (a.type === 'group' ? -1 : 1));

// Print
let lastDay = '';
for (const ev of allEvents) {
  const d = new Date(ev.time * 1000);
  const day = d.toISOString().slice(0, 10);
  const hm = d.toISOString().slice(11, 16);
  if (day !== lastDay) {
    console.log();
    console.log('--- ' + day + ' ---');
    console.log('time   group  llm');
    lastDay = day;
  }
  const groupCol = ev.type === 'group' ? ev.label : '   ';
  const llmCol = ev.type === 'llm' ? ev.label : ' ';
  console.log(hm + '  ' + groupCol + '    ' + llmCol);
}
