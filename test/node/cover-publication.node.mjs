import assert from "node:assert/strict";
import { test } from "node:test";
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync,existsSync,chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync,execFileSync} from "node:child_process";
const helper = new URL("../../scripts/start-cover-checks.mjs", import.meta.url);
const startCoverChecks = options => import(helper).then(module => module.startCoverChecks(options));

const repository = "owner/project";
const sourceSha = "a".repeat(40);
const headSha = "b".repeat(40);
const number = 42;
function fixture() {
  const pr = {
    state: "open", draft: false, changed_files: 1,
    base: { ref: "main", sha: sourceSha, repo: { full_name: repository } },
    head: { ref: `automation/project-cover-${sourceSha}`, sha: headSha, repo: { full_name: repository } },
    user: { login: "github-actions[bot]" },
  };
  const files = [{ filename: "docs/screenshots/cover.png", status: "modified" }];
  const run = { id: 123, event: "pull_request", head_sha: headSha, head_repository: { full_name: repository }, path: ".github/workflows/ci.yml", conclusion: "action_required", pull_requests: [{ number }] };
  const writes = [];
  const data = { pr, files, runs: [run], writes };
  let time = 0;
  data.options = {
    repository, sourceSha, expectedHeadSha: headSha, number, workflows: ["ci.yml"],
    now: () => time, sleep: async milliseconds => { time += milliseconds; }, log: () => {},
    api: async (path, method = "GET") => {
      if (method === "POST") { writes.push(path); return null; }
      if (path.endsWith("/files")) return files;
      if (path.includes("/actions/runs?")) return { total_count: data.runs.length, workflow_runs: data.runs };
      return structuredClone(pr);
    },
  };
  return data;
}

test("starts the normal PR workflow after validating the generated image change", async () => {
  const data = fixture();
  const result=await startCoverChecks(data.options);
  assert.equal(result.headSha,headSha);
  assert.deepEqual(data.writes, [`repos/${repository}/actions/runs/123/approve`]);
});

for (const [name, tamper] of [
  ["source code change", data => { data.files[0].filename = "src/app.js"; }],
  ["additional file", data => { data.pr.changed_files = 2; }],
  ["foreign repository", data => { data.pr.head.repo.full_name = "other/project"; }],
  ["different branch", data => { data.pr.head.ref = "feature/new-code"; }],
  ["different author", data => { data.pr.user.login = "contributor"; }],
  ["superseded source", data => { data.pr.base.sha = "c".repeat(40); }],
  ["different checked commit", data => { data.runs[0].head_sha = "c".repeat(40); }],
  ["different pull request", data => { data.runs[0].pull_requests = [{ number: 99 }]; }],
  ["non-PR workflow", data => { data.runs[0].event = "workflow_dispatch"; }],
]) {
  test(`refuses ${name} without approving any workflow`, async () => {
    const data = fixture();
    tamper(data);
    await assert.rejects(startCoverChecks(data.options));
    assert.deepEqual(data.writes, []);
  });
}

test("refuses an initial PR head substituted after local candidate verification", async () => {
  const data = fixture();
  data.pr.head.sha = "c".repeat(40);
  data.runs[0].head_sha = data.pr.head.sha;
  await assert.rejects(startCoverChecks(data.options));
  assert.deepEqual(data.writes, []);
});

test("does not approve an unrelated workflow", async () => {
  const data = fixture();
  data.runs.unshift({ ...data.runs[0], id: 456, path: ".github/workflows/release.yml" });
  await startCoverChecks(data.options);
  assert.deepEqual(data.writes, [`repos/${repository}/actions/runs/123/approve`]);
});

test("waits for delayed workflow creation", async () => {
  const data = fixture();
  const run = data.runs[0];
  data.runs = [];
  const sleep = data.options.sleep;
  data.options.sleep = async milliseconds => {
    await sleep(milliseconds);
    data.runs = [run];
  };
  await startCoverChecks(data.options);
  assert.deepEqual(data.writes, [`repos/${repository}/actions/runs/123/approve`]);
});

test("stops when expected workflows never appear", async () => {
  const data = fixture();
  data.runs = [];
  await assert.rejects(startCoverChecks(data.options), /Timed out waiting/);
  assert.deepEqual(data.writes, []);
});

test("does not reapprove workflows that already started", async () => {
  const data = fixture();
  data.runs[0].conclusion = null;
  await startCoverChecks(data.options);
  assert.deepEqual(data.writes, []);
});

for (const effect of ['approve','return']) test(`refuses a changed PR head immediately before ${effect}`,async()=>{
  const data=fixture();const api=data.options.api;
  data.runs[0].conclusion=effect==='approve'?'action_required':null;
  data.options.api=async(path,method='GET')=>{
    const result=await api(path,method);
    if(path.includes('/actions/runs?'))data.pr.head.sha='c'.repeat(40);
    return result;
  };
  await assert.rejects(startCoverChecks(data.options));
  assert.deepEqual(data.writes,[]);
});
for(const changed of ['draft','closed','invalid head','removed image','too many runs'])test(`refuses ${changed} without workflow approval`,async()=>{
  const data=fixture();
  if(changed==='draft')data.pr.draft=true;
  if(changed==='closed')data.pr.state='closed';
  if(changed==='invalid head')data.pr.head.sha='not-a-sha';
  if(changed==='removed image')data.files[0].status='removed';
  if(changed==='too many runs')data.runs=Array(101).fill(data.runs[0]);
  await assert.rejects(startCoverChecks(data.options));assert.deepEqual(data.writes,[]);
});
function publisherFixture(t){
  const root=mkdtempSync(join(tmpdir(),'hookrelay-cover-publisher-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const cwd=join(root,'checkout'),remote=join(root,'remote.git'),bin=join(root,'bin');
  mkdirSync(cwd);mkdirSync(bin);
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','--quiet','-b','main');git('config','user.name','Synthetic maintainer');git('config','user.email','synthetic@example.invalid');git('config','commit.gpgsign','false');git('config','core.hooksPath',join(root,'no-hooks'));
  mkdirSync(join(cwd,'docs/screenshots'),{recursive:true});mkdirSync(join(cwd,'scripts'));
  writeFileSync(join(cwd,'docs/screenshots/cover.png'),'synthetic-old-cover');
  if(existsSync(helper))writeFileSync(join(cwd,'scripts/start-cover-checks.mjs'),readFileSync(helper));
  git('add','docs/screenshots/cover.png');
  if(existsSync(helper))git('add','scripts/start-cover-checks.mjs');
  git('commit','--quiet','-m','Synthetic source');
  const sourceSha=git('rev-parse','HEAD');
  execFileSync('git',['init','--quiet','--bare',remote]);git('remote','add','origin',remote);git('push','--quiet','-u','origin','main');
  git('checkout','--quiet','--detach',sourceSha);
  const artifact=join(root,'cover.png');writeFileSync(artifact,'synthetic-new-cover');
  const stateFile=join(root,'provider.json');writeFileSync(stateFile,JSON.stringify({sourceSha,created:0,approved:0,merged:0}));
  writeFileSync(join(bin,'gh'),`#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const file=process.env.COVER_TEST_STATE;const state=JSON.parse(fs.readFileSync(file,'utf8'));const args=process.argv.slice(2);
const branch='refs/heads/automation/project-cover-'+state.sourceSha;
const sha=cp.execFileSync('git',['ls-remote','origin',branch],{encoding:'utf8'}).trim().split(/\\s+/)[0];
const save=()=>fs.writeFileSync(file,JSON.stringify(state));
const result=value=>process.stdout.write(typeof value==='string'?value:JSON.stringify(value));
if(args[0]==='pr'&&args[1]==='list')result(state.created?'https://github.com/owner/project/pull/42':'');
else if(args[0]==='pr'&&args[1]==='create'){state.created++;save();result('https://github.com/owner/project/pull/42')}
else if(args[0]==='pr'&&args[1]==='view')result('42');
else if(args[0]==='pr'&&args[1]==='merge'){
 if(!args.includes('--auto')||!args.includes('--squash')||args[args.indexOf('--match-head-commit')+1]!==sha)process.exit(91);
 state.merged++;save();
}else if(args[0]==='api'){
 const path=args.at(-1);
 if(args.includes('POST')){if(!path.endsWith('/actions/runs/123/approve'))process.exit(92);state.approved++;save();result('')}
 else if(path.includes('/actions/runs?'))result({total_count:1,workflow_runs:[{id:123,path:'.github/workflows/ci.yml',event:'pull_request',head_sha:sha,head_repository:{full_name:'owner/project'},pull_requests:[{number:42}],conclusion:state.approved?null:'action_required'}]});
 else if(path.endsWith('/files'))result([{filename:'docs/screenshots/cover.png',status:'modified'}]);
 else result({state:'open',draft:false,changed_files:1,user:{login:'github-actions[bot]'},base:{ref:'main',sha:state.sourceSha,repo:{full_name:'owner/project'}},head:{ref:'automation/project-cover-'+state.sourceSha,sha,repo:{full_name:'owner/project'}}});
}else process.exit(93);
`,{mode:0o755});
  const workflow=readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
  const publisher=workflow.slice(workflow.indexOf('  publish-cover:'));
  const marker='        run: |\n';const body=publisher.slice(publisher.indexOf(marker)+marker.length).split('\n').map(line=>line.replace(/^          /,'')).join('\n');
  const run=()=>spawnSync('/bin/bash',['-e','-c',body],{cwd,encoding:'utf8',timeout:30000,env:{...process.env,PATH:bin+':'+process.env.PATH,GH_TOKEN:'synthetic-test-token',GITHUB_REPOSITORY:'owner/project',GITHUB_SERVER_URL:'https://github.com',GITHUB_SHA:sourceSha,GITHUB_RUN_ID:'synthetic-run',COVER_WORKFLOWS:'ci.yml',COVER_ARTIFACT:artifact,RUNNER_TEMP:root,COVER_TEST_STATE:stateFile}});
  return {cwd,git,run,sourceSha,artifact,state:()=>JSON.parse(readFileSync(stateFile,'utf8')),publisher};
}
test('actual cover publisher reuses its image-only PR, approves only its workflow and never pushes main',t=>{
  const f=publisherFixture(t);
  const first=f.run();assert.equal(first.status,0,first.stderr);
  assert.equal(f.git('rev-parse','origin/main'),f.sourceSha);
  assert.deepEqual(f.state(),{sourceSha:f.sourceSha,created:1,approved:1,merged:1});
  assert.equal(f.git('ls-remote','--heads','origin').split('\n').length,2);
  f.git('checkout','--quiet','--detach',f.sourceSha);
  const rerun=f.run();assert.equal(rerun.status,0,rerun.stderr);
  assert.deepEqual(f.state(),{sourceSha:f.sourceSha,created:1,approved:1,merged:2});
  assert.match(f.publisher,/pull-requests: write/);assert.match(f.publisher,/actions: write/);
  assert.match(f.publisher,/github.ref == 'refs\/heads\/main'/);assert.match(f.publisher,/github.event_name != 'pull_request'/);
});
test('actual cover publisher skips a superseded source without a branch or PR write',t=>{
  const f=publisherFixture(t);f.git('checkout','--quiet','main');writeFileSync(join(f.cwd,'later.txt'),'later source');f.git('add','later.txt');f.git('commit','--quiet','-m','Later synthetic source');f.git('push','--quiet','origin','main');f.git('checkout','--quiet','--detach',f.sourceSha);
  const result=f.run();assert.equal(result.status,0,result.stderr);assert.deepEqual(f.state(),{sourceSha:f.sourceSha,created:0,approved:0,merged:0});
});
test('actual cover publisher refuses a same-named automation branch containing source changes',t=>{
  const f=publisherFixture(t);writeFileSync(join(f.cwd,'unreviewed.txt'),'unreviewed source');f.git('add','unreviewed.txt');f.git('commit','--quiet','-m','Unreviewed source');f.git('push','--quiet','origin','HEAD:refs/heads/automation/project-cover-'+f.sourceSha);f.git('checkout','--quiet','--detach',f.sourceSha);
  const result=f.run();assert.notEqual(result.status,0);assert.deepEqual(f.state(),{sourceSha:f.sourceSha,created:0,approved:0,merged:0});assert.equal(f.git('rev-parse','origin/main'),f.sourceSha);
});
for (const tamper of ['different image', 'executable image']) test(`actual cover publisher refuses a same-named image-only branch with ${tamper}`, t => {
  const f = publisherFixture(t);
  const cover = join(f.cwd, 'docs/screenshots/cover.png');
  writeFileSync(cover, tamper === 'different image' ? 'substituted-image' : readFileSync(f.artifact));
  if (tamper === 'executable image') chmodSync(cover, 0o755);
  f.git('add', 'docs/screenshots/cover.png');
  f.git('commit', '--quiet', '-m', 'Substituted image');
  f.git('push', '--quiet', 'origin', 'HEAD:refs/heads/automation/project-cover-' + f.sourceSha);
  f.git('checkout', '--quiet', '--detach', f.sourceSha);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.state(), {sourceSha: f.sourceSha, created: 0, approved: 0, merged: 0});
  assert.equal(f.git('rev-parse', 'origin/main'), f.sourceSha);
});
test('cover helper CLI has offline help, validates input and requires environment before provider calls',()=>{
  const run=(args,extra={})=>spawnSync(process.execPath,[helper.pathname,...args],{encoding:'utf8',env:{PATH:process.env.PATH,...extra}});
  for(const flag of ['--help','-h']){const r=run([flag]);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/Usage:/)}
  for(const args of [[],['0'],['--unknown'],['42','extra']])assert.equal(run(args).status,2);
  assert.equal(run(['42']).status,2);
});
