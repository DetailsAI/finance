/**
 * DETAILS Financials — Supabase API
 * /.netlify/functions/db
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const h = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS' };

async function sb(method, path, body) {
  const r = await fetch(SUPABASE_URL+'/rest/v1/'+path, {
    method,
    headers:{ 'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json','Prefer':method==='POST'?'resolution=merge-duplicates,return=minimal':'return=minimal' },
    ...(body!==undefined?{body:JSON.stringify(body)}:{})
  });
  if(!r.ok){const e=await r.text();throw new Error(path+' '+r.status+': '+e.slice(0,150));}
  const t=await r.text(); return t?JSON.parse(t):[];
}

async function upsert(table, rows) {
  if(!rows||!rows.length) return;
  for(let i=0;i<rows.length;i+=50) await sb('POST',table,rows.slice(i,i+50));
}

// ── SAVE USERS ONLY (lightweight, called on every saveDB) ─────────
async function saveUsers(data) {
  const {users=[], companies=[]} = data;
  await Promise.all([
    users.length ? upsert('users', users.map(u=>({
      id:u.id, username:u.username, full_name:u.fullName||u.username,
      email:u.email||null, password_hash:u.passwordHash||u.password||'',
      role:u.role||'Viewer', is_active:u.isActive!==false,
      company_access:u.companyAccess||null, permissions:u.permissions||{}
    }))) : Promise.resolve(),
    companies.length ? upsert('companies', companies.map(c=>({
      id:c.id, code:c.code, name:c.name,
      country:c.country||'Pakistan', currency:c.currency||'USD', fy_start:c.fyStart||'01-01'
    }))) : Promise.resolve(),
  ]);
  return {saved:true};
}

// ── FULL SAVE (called on explicit Sync button) ────────────────────
async function saveDB(db) {
  // 1. Users + companies (fast)
  await saveUsers({users:db.users, companies:db.companies});

  // 2. Everything else per company
  for(const [coId, coData] of Object.entries(db.data||{})) {
    if(!coData) continue;
    const ops=[];

    if(coData.accounts?.length) ops.push(upsert('accounts', coData.accounts.map(a=>({ id:a.id, company_id:coId, code:a.code, name:a.name, class:a.cls||'EXPENSE', cf_category:a.cf||'OPERATING', parent_id:a.parentId||null, description:a.desc||null, is_shared:false, is_active:true }))));
    if(db.shared?.accounts?.length) ops.push(upsert('accounts', db.shared.accounts.map(a=>({ id:a.id, company_id:null, code:a.code, name:a.name, class:a.cls||'EXPENSE', cf_category:a.cf||'OPERATING', parent_id:a.parentId||null, description:a.desc||null, is_shared:true, is_active:true }))));
    if(coData.parties?.length) ops.push(upsert('parties', coData.parties.map(p=>({ id:p.id, company_id:coId, code:p.code||null, name:p.name, type:p.type||'Other', contact:p.contact||null, is_shared:false, is_active:true }))));
    if(coData.periods?.length) ops.push(upsert('periods', coData.periods.map(p=>({ id:p.id, company_id:coId, name:p.name, date_from:p.from, date_to:p.to, status:p.status||'OPEN', closed_at:p.closedAt||null }))));
    if(coData.donors?.length){
      ops.push(upsert('donors', coData.donors.map(d=>({ id:d.id, code:d.code||'D', name:d.name, country:d.country||null, is_core:!!d.isCore, is_active:true }))));
      ops.push(upsert('company_donors', coData.donors.map(d=>({ company_id:coId, donor_id:d.id }))));
    }
    if(coData.projects?.length){
      ops.push(upsert('projects', coData.projects.map(p=>({ id:p.id, code:p.code, name:p.name, primary_donor_id:p.donorId||null, status:p.status||'ACTIVE', description:p.desc||null, budget_total:p.budget?.total||0, budget_from:p.budget?.from||null, budget_to:p.budget?.to||null, budget_lines:p.budget?.lines||{}, is_core:!!p.isCore, is_active:true }))));
      ops.push(upsert('company_projects', coData.projects.map(p=>({ company_id:coId, project_id:p.id }))));
    }
    await Promise.all(ops);

    // Transactions last (heaviest)
    if(coData.transactions?.length){
      await upsert('transactions', coData.transactions.map(t=>({ id:t.id, company_id:coId, date:t.date, ref:t.ref, narration:t.narration||'', voucher_type:t.voucherType||'JV', ext_ref:t.extref||null, project_id:t.projectId||null, donor_id:t.donorId||null, party_id:t.partyId||null, is_deleted:false })));
      const lines=[], allocs=[];
      coData.transactions.forEach(t=>{
        (t.lines||[]).forEach((l,i)=>{ if(!l.acct) return; lines.push({ id:l.id||(t.id+'_l'+i), transaction_id:t.id, account_id:l.acct, debit:l.dr||0, credit:l.cr||0, description:l.desc||null, line_ref:l.lineref||null, project_id:l.projId||null, donor_id:l.donorId||null, party_id:l.partyId||null, sort_order:i }); });
        (t.allocations||[]).forEach((a,i)=>{ if(!a.projId||!a.pct) return; allocs.push({ id:t.id+'_a'+i, transaction_id:t.id, project_id:a.projId, percentage:a.pct, is_auto_core:!!a.isAuto }); });
      });
      if(lines.length) await upsert('transaction_lines', lines);
      if(allocs.length) await upsert('allocations', allocs);
    }
  }
  return {saved:true, timestamp:new Date().toISOString()};
}

// ── LOAD ─────────────────────────────────────────────────────────
async function loadDB() {
  const [companies, users, accounts, donors, projects, parties, periods, transactions, lines, allocations, coProjects, coDonors] = await Promise.all([
    sb('GET','companies?order=name&select=*'), sb('GET','users?order=username&select=*'),
    sb('GET','accounts?order=code&select=*'), sb('GET','donors?order=name&select=*'),
    sb('GET','projects?order=code&select=*'), sb('GET','parties?order=name&select=*'),
    sb('GET','periods?order=date_from&select=*'), sb('GET','transactions?order=date,ref&is_deleted=eq.false&select=*'),
    sb('GET','transaction_lines?order=transaction_id,sort_order&select=*'), sb('GET','allocations?order=transaction_id&select=*'),
    sb('GET','company_projects?select=company_id,project_id'), sb('GET','company_donors?select=company_id,donor_id'),
  ]);
  const txL={},txA={},coP={},coD={};
  lines.forEach(l=>(txL[l.transaction_id]=txL[l.transaction_id]||[]).push(l));
  allocations.forEach(a=>(txA[a.transaction_id]=txA[a.transaction_id]||[]).push(a));
  coProjects.forEach(r=>(coP[r.company_id]=coP[r.company_id]||[]).push(r.project_id));
  coDonors.forEach(r=>(coD[r.company_id]=coD[r.company_id]||[]).push(r.donor_id));
  const db={
    companies:companies.map(c=>({id:c.id,code:c.code,name:c.name,country:c.country,currency:c.currency,fyStart:c.fy_start})),
    users:users.map(u=>({id:u.id,username:u.username,fullName:u.full_name,email:u.email,password:u.password_hash,passwordHash:u.password_hash,role:u.role,isActive:u.is_active,companyAccess:u.company_access,permissions:u.permissions||{}})),
    data:{}, shared:{accounts:accounts.filter(a=>a.is_shared).map(a=>({id:a.id,code:a.code,name:a.name,cls:a.class,cf:a.cf_category,parentId:a.parent_id||undefined,desc:a.description||''})),parties:[]},
    activeCompanyId:companies[0]?.id||null,
  };
  companies.forEach(co=>{
    const pIds=coP[co.id]||projects.map(p=>p.id), dIds=coD[co.id]||donors.map(d=>d.id);
    db.data[co.id]={
      accounts:accounts.filter(a=>a.company_id===co.id).map(a=>({id:a.id,code:a.code,name:a.name,cls:a.class,cf:a.cf_category,parentId:a.parent_id||undefined,desc:a.description||''})),
      parties:parties.filter(p=>p.company_id===co.id).map(p=>({id:p.id,code:p.code,name:p.name,type:p.type,contact:p.contact||''})),
      periods:periods.filter(p=>p.company_id===co.id).map(p=>({id:p.id,name:p.name,from:p.date_from,to:p.date_to,status:p.status,closedAt:p.closed_at})),
      projects:projects.filter(p=>pIds.includes(p.id)).map(p=>({id:p.id,code:p.code,name:p.name,donorId:p.primary_donor_id,status:p.status,desc:p.description,isCore:p.is_core,budget:{total:parseFloat(p.budget_total)||0,from:p.budget_from,to:p.budget_to,lines:p.budget_lines||{}}})),
      donors:donors.filter(d=>dIds.includes(d.id)).map(d=>({id:d.id,code:d.code,name:d.name,country:d.country,isCore:d.is_core})),
      transactions:transactions.filter(t=>t.company_id===co.id).map(t=>({id:t.id,date:t.date,ref:t.ref,narration:t.narration,voucherType:t.voucher_type,extref:t.ext_ref,projectId:t.project_id,donorId:t.donor_id,partyId:t.party_id,lines:(txL[t.id]||[]).map(l=>({id:l.id,acct:l.account_id,dr:parseFloat(l.debit)||0,cr:parseFloat(l.credit)||0,desc:l.description||'',lineref:l.line_ref||'',projId:l.project_id||'',donorId:l.donor_id||'',partyId:l.party_id||''})),allocations:(txA[t.id]||[]).map(a=>({projId:a.project_id,pct:parseFloat(a.percentage),isAuto:a.is_auto_core}))})),
    };
  });
  return db;
}

// ── AI RELAY ─────────────────────────────────────────────────────
async function aiRelay(body,params){
  const key=body?.aiKey||params?.aiKey||process.env.ANTHROPIC_API_KEY;
  const prompt=body?.prompt||decodeURIComponent(params?.prompt||'');
  if(!key||!prompt) return {error:'Missing key or prompt'};
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','Content-Type':'application/json'},body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:parseInt(body?.maxTokens||'1000'),messages:[{role:'user',content:prompt}]})});
  const d=await r.json();
  if(!r.ok) return {error:'AI '+r.status};
  return {success:true,text:d.content?.[0]?.text||''};
}

// ── HANDLER ──────────────────────────────────────────────────────
exports.handler=async(event)=>{
  if(event.httpMethod==='OPTIONS') return {statusCode:200,headers:h,body:''};
  if(!SUPABASE_URL||!SUPABASE_KEY) return {statusCode:500,headers:h,body:JSON.stringify({error:'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY'})};
  try{
    const params=event.queryStringParameters||{};
    const body=event.httpMethod==='POST'?JSON.parse(event.body||'{}'):{};
    const action=params.action||body.action||'load';
    if(action==='ping') return {statusCode:200,headers:h,body:JSON.stringify({success:true,message:'DETAILS Supabase API OK',timestamp:new Date().toISOString()})};
    if(action==='load'||action==='get'){const db=await loadDB();return{statusCode:200,headers:h,body:JSON.stringify({success:true,db,timestamp:new Date().toISOString()})};}
    if(action==='saveUsers'){const r=await saveUsers(body);return{statusCode:200,headers:h,body:JSON.stringify({success:true,...r})};}
    if(action==='save'){if(body.db){const r=await saveDB(body.db);return{statusCode:200,headers:h,body:JSON.stringify({success:true,...r})};}}
    if(action==='ai'){const r=await aiRelay(body,params);return{statusCode:200,headers:h,body:JSON.stringify(r)};}
    return {statusCode:400,headers:h,body:JSON.stringify({error:'Unknown action: '+action})};
  }catch(err){
    console.error('db error:',err.message);
    return {statusCode:500,headers:h,body:JSON.stringify({success:false,error:err.message})};
  }
};
