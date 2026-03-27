import"./styles-BSFMD8af.js";const Y="agent-relay.device-id",E="agent-relay.api-token",se=5e3,K=250,r={apiToken:Ge(),controllerHeartbeatTimer:null,controllerLeaseRefreshTimer:null,currentApprovalId:null,currentPairing:null,deviceId:We(),defaultsSeeded:!1,newSessionPanelOpen:!1,selectedCwd:"",session:null,sessionStream:null,streamConnected:!1,streamReconnectTimer:null,sessionPollTimer:null,threads:[],threadsPollTimer:null},f=document.querySelector("#transcript"),q=document.querySelector("#client-log"),ce=document.querySelector("#connection-form"),D=document.querySelector("#api-token-input"),A=document.querySelector("#start-pairing-button"),de=document.querySelector("#pairing-panel"),V=document.querySelector("#pairing-qr"),W=document.querySelector("#pairing-expiry"),T=document.querySelector("#pairing-link-input"),le=document.querySelector("#copy-pairing-link-button"),ue=document.querySelector("#refresh-button"),pe=document.querySelector("#threads-refresh-button"),R=document.querySelector("#send-button"),me=document.querySelector("#message-form"),w=document.querySelector("#message-input"),X=document.querySelector("#message-effort"),ve=document.querySelector("#directory-form"),fe=document.querySelector("#load-directory-button"),I=document.querySelector("#new-session-toggle"),he=document.querySelector("#new-session-panel"),Z=document.querySelector("#start-session-button"),_=document.querySelector("#cwd-input"),ee=document.querySelector("#start-prompt"),k=document.querySelector("#model-input"),M=document.querySelector("#approval-policy-input"),j=document.querySelector("#sandbox-input"),B=document.querySelector("#start-effort"),y=document.querySelector("#threads-list"),u=document.querySelector("#threads-count"),O=document.querySelector("#paired-devices-list"),ge=document.querySelector("#workspace-title"),ye=document.querySelector("#workspace-subtitle"),l=document.querySelector("#status-badge"),H=document.querySelector("#session-meta"),G=document.querySelector("#control-banner"),P=document.querySelector("#control-summary"),x=document.querySelector("#control-hint"),p=document.querySelector("#take-over-button");ce.addEventListener("submit",e=>{e.preventDefault(),Me(D.value)});A.addEventListener("click",()=>{Te()});le.addEventListener("click",()=>{ke()});ue.addEventListener("click",()=>{m("manual refresh")});pe.addEventListener("click",()=>{v("manual refresh")});ve.addEventListener("submit",e=>{e.preventDefault(),S(_.value.trim()),v("directory change")});I.addEventListener("click",()=>{L(!r.newSessionPanelOpen)});Z.addEventListener("click",()=>{_e()});p.addEventListener("click",()=>{$e()});me.addEventListener("submit",e=>{e.preventDefault(),be()});f.addEventListener("click",e=>{const t=e.target.closest("[data-approval-decision]");t&&Le(t.dataset.approvalDecision,t.dataset.approvalScope||"once")});O.addEventListener("click",e=>{const t=e.target.closest("[data-revoke-device-id]");t&&Ce(t.dataset.revokeDeviceId)});we();async function we(){D.value=r.apiToken,L(!1),await m("initial boot"),r.selectedCwd?await v("initial boot"):C([]),F(),re()}async function m(e){a(`Fetching session snapshot (${e})`);try{const t=await d("/api/session"),n=await t.json();if(!t.ok||!n.ok)throw new Error(n?.error?.message||"Failed to load session");$(n.data),h(n.data)}catch(t){r.session=null,ae(),oe(),l.textContent="Offline",l.className="status-badge status-badge-offline",H.innerHTML=`<span class="meta-empty">${o(t.message)}</span>`,f.innerHTML=`
      <div class="thread-empty">
        <h2>Relay unavailable</h2>
        <p>${o(t.message)}</p>
      </div>
    `,a(`Session fetch failed: ${t.message}`)}finally{r.streamConnected||N()}}async function v(e){if(!r.selectedCwd){r.threads=[],C([]),a("History skipped because no directory is selected.");return}u.textContent="Loading...",u.title=r.selectedCwd,a(`Fetching thread list for ${r.selectedCwd} (${e})`);try{const t=new URL("/api/threads",window.location.origin);t.searchParams.set("cwd",r.selectedCwd),t.searchParams.set("limit","80");const n=await d(t),i=await n.json();if(!n.ok||!i.ok)throw new Error(i?.error?.message||"Failed to load threads");r.threads=i.data.threads,C(i.data.threads)}catch(t){u.textContent="Error",y.innerHTML=`<p class="sidebar-empty">${o(t.message)}</p>`,a(`Thread fetch failed: ${t.message}`)}finally{re()}}async function _e(){const e=_.value.trim();if(!e){a("Choose a directory before starting a session."),_.focus();return}S(e),z(!0),a(`Starting a new Codex thread in ${e}`);try{const t=await d("/api/session/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({cwd:e,initial_prompt:ee.value.trim()||null,model:k.value.trim()||null,approval_policy:M.value,sandbox:j.value,effort:B.value,device_id:r.deviceId})}),n=await t.json();if(!t.ok||!n.ok)throw new Error(n?.error?.message||"Failed to start session");r.defaultsSeeded=!1,S(n.data.current_cwd||e),$(n.data),h(n.data),await v("post-start refresh"),L(!1),a("Started a new Codex thread")}catch(t){a(`Session start failed: ${t.message}`)}finally{z(!1)}}async function Se(e){a(`Resuming thread ${e}`);try{const t=await d("/api/session/resume",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({thread_id:e,device_id:r.deviceId})}),n=await t.json();if(!t.ok||!n.ok)throw new Error(n?.error?.message||"Failed to resume session");r.defaultsSeeded=!1,S(n.data.current_cwd||r.selectedCwd),$(n.data),h(n.data),await v("post-resume refresh"),L(!1),a(`Resumed thread ${e}`)}catch(t){a(`Resume failed: ${t.message}`)}}async function be(){const e=w.value.trim();if(!e){a("Message is empty.");return}R.disabled=!0,a("Sending prompt to Codex");try{const t=await d("/api/session/message",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:e,effort:X.value,device_id:r.deviceId})}),n=await t.json();if(!t.ok||!n.ok)throw new Error(n?.error?.message||"Failed to send prompt");w.value="",h(n.data),a("Prompt accepted by relay")}catch(t){a(`Prompt failed: ${t.message}`)}finally{R.disabled=!1}}async function Te(){A.disabled=!0,a("Creating a broker pairing ticket.");try{const e=await d("/api/pairing/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})}),t=await e.json();if(!e.ok||!t.ok)throw new Error(t?.error?.message||"Failed to start pairing");r.currentPairing=t.data,te(),a(`Pairing ticket ${t.data.pairing_id} is ready.`)}catch(e){a(`Pairing failed: ${e.message}`)}finally{A.disabled=!1}}async function ke(){const e=r.currentPairing?.pairing_url;if(!e){a("No pairing link is available yet.");return}try{await navigator.clipboard.writeText(e),a("Copied pairing link to clipboard.")}catch(t){T.focus(),T.select(),a(`Clipboard copy failed: ${t.message}`)}}async function Ce(e){if(e){a(`Revoking paired device ${s(e)}.`);try{const t=await d(`/api/devices/${encodeURIComponent(e)}/revoke`,{method:"POST"}),n=await t.json();if(!t.ok||!n.ok)throw new Error(n?.error?.message||"Failed to revoke paired device");await m("post-device-revoke refresh"),a(`Revoked paired device ${s(e)}.`)}catch(t){a(`Revoke failed: ${t.message}`)}}}async function $e(){if(!r.session?.active_thread_id){a("There is no active session to take over.");return}p.disabled=!0,a(`Taking control from device ${s(r.deviceId)}`);try{const e=await d("/api/session/take-over",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({device_id:r.deviceId})}),t=await e.json();if(!e.ok||!t.ok)throw new Error(t?.error?.message||"Failed to take control");h(t.data),w.focus(),a("This device now has control.")}catch(e){a(`Take over failed: ${e.message}`)}finally{p.disabled=!1}}async function Le(e,t){if(!r.currentApprovalId){a("No pending approval to submit.");return}a(`Submitting ${e} for ${r.currentApprovalId}`);try{const n=await d(`/api/approvals/${encodeURIComponent(r.currentApprovalId)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({decision:e,scope:t,device_id:r.deviceId})}),i=await n.json();if(!n.ok||!i.ok)throw new Error(i?.error?.message||"Approval submission failed");a(i.data.message),await m("post-decision refresh")}catch(n){a(`Approval failed: ${n.message}`)}}function h(e){r.session=e;const t=e.pending_approvals[0]||null,n=Oe(e.active_thread_id),i=!!e.active_thread_id,g=Ve(e);r.currentApprovalId=t?.request_id||null,ge.textContent=e.active_thread_id?n?.name||n?.preview||s(e.active_thread_id):"New session",ye.textContent=e.active_thread_id?e.current_cwd:"Pick a workspace on the left and start or resume a session.",t?(l.textContent="Approval required",l.className="status-badge status-badge-alert"):e.codex_connected?(l.textContent=e.current_status||"Ready",l.className="status-badge status-badge-ready"):(l.textContent="Offline",l.className="status-badge status-badge-offline"),xe(e),te(),Pe(e.paired_devices||[]),Ee(e),qe(e.transcript,t),Ie(e.logs),C(r.threads),ne(e),Ne(e),R.disabled=!i||!g,w.disabled=!i||!g,w.placeholder=i?g?"Message Codex...":"Another device has control. Take over to reply.":"Start or resume a session first."}function te(){const e=r.currentPairing;if(de.hidden=!e,!e){V.innerHTML="",T.value="",W.textContent="Pairing ticket not created yet.";return}V.innerHTML=e.pairing_qr_svg,T.value=e.pairing_url,W.textContent=`Expires ${J(e.expires_at)}`}function Pe(e){if(!e.length){O.innerHTML='<p class="sidebar-empty">No remote devices paired yet.</p>';return}O.innerHTML=e.map(t=>{const n=t.last_seen_at?`Seen ${J(t.last_seen_at)}`:"Never seen";return`
        <article class="paired-device-card">
          <div class="paired-device-copy">
            <strong>${o(t.label)}</strong>
            <p class="paired-device-meta">${o(s(t.device_id))} · ${o(n)}</p>
          </div>
          <button
            class="sidebar-link-button"
            type="button"
            data-revoke-device-id="${o(t.device_id)}"
          >
            Revoke
          </button>
        </article>
      `}).join("")}function xe(e){const t=[c("Security",Fe(e)),c("Visibility",Ue(e)),c("Broker",Je(e)),c("Devices",Ye(e))];if(!e.active_thread_id){H.innerHTML=[...t,'<span class="meta-empty">Session details will appear here.</span>'].join("");return}H.innerHTML=[...t,c("Directory",e.current_cwd||"None"),c("Model",e.model),c("Approval",e.approval_policy),c("Sandbox",e.sandbox),c("Effort",e.reasoning_effort),c("Control",e.active_controller_device_id?ie(e.active_controller_device_id):"Unclaimed"),c("Thread",s(e.active_thread_id))].join("")}function Ee(e){if(!e.active_thread_id){G.hidden=!0,p.hidden=!0;return}if(G.hidden=!1,!e.active_controller_device_id){P.textContent="No device currently has control",x.textContent="The next device to send a message will claim control.",p.hidden=!0;return}if(b(e)){P.textContent="This device has control",x.textContent="You can type here. Other owner devices can still approve pending actions.",p.hidden=!0;return}P.textContent=e.active_controller_device_id?`Another device has control (${ie(e.active_controller_device_id)})`:"No device currently has control",x.textContent="You can still approve from this device. Take over when you want to type or continue the session.",p.hidden=!1}function qe(e,t){if(!e.length&&!t){f.innerHTML=`
      <div class="thread-empty">
        <h2>No active conversation yet</h2>
        <p>Start a new session or resume one from the sidebar.</p>
      </div>
    `;return}const n=e.map(Ae);t&&n.push(Re(t)),f.innerHTML=`<div class="thread-content">${n.join("")}</div>`,f.scrollTop=f.scrollHeight}function Ae(e){const t=e.role||"system";return t==="user"?`
      <article class="chat-message chat-message-user">
        <div class="message-card">
          <div class="message-meta">
            <strong>You</strong>
            <span>${o(e.status||"completed")}</span>
          </div>
          <div class="message-body">${o(e.text||"(empty)")}</div>
        </div>
      </article>
    `:t==="assistant"?`
      <article class="chat-message chat-message-assistant">
        <div class="message-avatar">C</div>
        <div class="message-card">
          <div class="message-meta">
            <strong>Codex</strong>
            <span>${o(e.status||"completed")}</span>
            <span>${o(s(e.turn_id||""))}</span>
          </div>
          <div class="message-body">${o(e.text||"(empty)")}</div>
        </div>
      </article>
    `:`
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-system">
        <div class="message-meta">
          <strong>${o(Ke(t))}</strong>
          <span>${o(e.status||"completed")}</span>
        </div>
        <pre class="message-pre">${o(e.text||"(empty)")}</pre>
      </div>
    </article>
  `}function Re(e){return`
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-approval">
        <div class="message-meta">
          <strong>Approval required</strong>
          <span>${o(e.kind)}</span>
        </div>
        <h3 class="approval-title">${o(e.summary)}</h3>
        <p class="approval-copy">${o(e.detail||"Codex is waiting for a remote approval.")}</p>
        ${e.cwd?`<p class="approval-copy">cwd: ${o(e.cwd)}</p>`:""}
        ${e.command?`<pre class="message-pre">${o(e.command)}</pre>`:""}
        ${e.requested_permissions?`<pre class="message-pre">${o(JSON.stringify(e.requested_permissions,null,2))}</pre>`:""}
        <div class="approval-actions">
          <button
            class="approval-button approval-button-primary"
            type="button"
            data-approval-decision="approve"
            data-approval-scope="once"
          >
            Approve
          </button>
          ${e.supports_session_scope?`
                <button
                  class="approval-button"
                  type="button"
                  data-approval-decision="approve"
                  data-approval-scope="session"
                >
                  Approve Session
                </button>
              `:""}
          <button
            class="approval-button approval-button-danger"
            type="button"
            data-approval-decision="deny"
            data-approval-scope="once"
          >
            Deny
          </button>
        </div>
      </div>
    </article>
  `}function C(e){const t=r.selectedCwd,n=r.session?.active_thread_id||null;if(!t){u.textContent="Choose a directory",u.title="",y.innerHTML='<p class="sidebar-empty">Choose a directory to load history sessions.</p>';return}if(u.textContent=`${e.length} ${e.length===1?"session":"sessions"}`,u.title=t,!e.length){y.innerHTML='<p class="sidebar-empty">No saved sessions found for this workspace.</p>';return}y.innerHTML=e.map(i=>{const g=i.name||i.preview||s(i.id);return`
        <button class="conversation-item${n===i.id?" is-active":""}" type="button" data-thread-id="${o(i.id)}">
          <span class="conversation-title">${o(g)}</span>
          <span class="conversation-preview">${o(i.preview||"No preview yet.")}</span>
          <span class="conversation-meta">${o(J(i.updated_at))}</span>
        </button>
      `}).join(""),y.querySelectorAll("[data-thread-id]").forEach(i=>{i.addEventListener("click",()=>{Se(i.dataset.threadId)})})}function Ie(e){q.textContent=e.map(t=>`${new Date(t.created_at*1e3).toLocaleTimeString()}  [${t.kind}] ${t.message}`).join(`
`)}function $(e){r.defaultsSeeded||(k.value||(k.value=e.model||"gpt-5-codex"),M.value=e.approval_policy,j.value=e.sandbox,B.value=e.reasoning_effort,X.value=e.reasoning_effort,r.defaultsSeeded=!0),!r.selectedCwd&&e.current_cwd&&S(e.current_cwd)}function S(e){r.selectedCwd=e,_.value=e}function Oe(e){return e&&r.threads.find(t=>t.id===e)||null}function z(e){[fe,Z,_,ee,k,M,j,B].forEach(t=>{t.disabled=e})}function L(e){r.newSessionPanelOpen=e,he.hidden=!e,I.setAttribute("aria-expanded",String(e)),I.textContent=e?"Close Session Setup":"New Session"}function N(){r.streamConnected||(r.sessionPollTimer&&window.clearTimeout(r.sessionPollTimer),r.sessionPollTimer=window.setTimeout(()=>{m("poll")},Be()))}function re(){r.threadsPollTimer&&window.clearTimeout(r.threadsPollTimer),r.threadsPollTimer=window.setTimeout(()=>{v("poll")},12e3)}function ne(e){ae(),!(!e?.active_thread_id||!b(e))&&(r.controllerHeartbeatTimer=window.setTimeout(()=>{He()},se))}async function He(){if(!(!r.session?.active_thread_id||!b(r.session)))try{const e=await d("/api/session/heartbeat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({device_id:r.deviceId})}),t=await e.json();if(!e.ok||!t.ok)throw new Error(t?.error?.message||"Failed to refresh control lease")}catch(e){a(`Control heartbeat failed: ${e.message}`)}finally{r.session?.active_thread_id&&b(r.session)&&ne(r.session)}}function ae(){r.controllerHeartbeatTimer&&(window.clearTimeout(r.controllerHeartbeatTimer),r.controllerHeartbeatTimer=null)}function Ne(e){if(oe(),!e?.active_thread_id||!e.active_controller_device_id||b(e)||!e.controller_lease_expires_at)return;const t=Math.max(K,e.controller_lease_expires_at*1e3-Date.now()+K);r.controllerLeaseRefreshTimer=window.setTimeout(()=>{m("controller lease expiry")},t)}function oe(){r.controllerLeaseRefreshTimer&&(window.clearTimeout(r.controllerLeaseRefreshTimer),r.controllerLeaseRefreshTimer=null)}function F(){if(!("EventSource"in window)){a("EventSource is unavailable. Falling back to polling."),r.streamConnected=!1,N();return}r.sessionStream&&r.sessionStream.close();const e=new EventSource(De());r.sessionStream=e,e.addEventListener("session",t=>{try{const n=JSON.parse(t.data);r.streamConnected=!0,Q(),$(n),h(n)}catch(n){a(`Stream payload failed: ${n.message}`)}}),e.onopen=()=>{r.streamConnected||a("Session stream connected."),r.streamConnected=!0,Q(),U()},e.onerror=()=>{r.sessionStream===e&&(a("Session stream disconnected. Falling back to polling."),r.streamConnected=!1,r.sessionStream.close(),r.sessionStream=null,N(),je())}}function Q(){r.sessionPollTimer&&(window.clearTimeout(r.sessionPollTimer),r.sessionPollTimer=null)}function d(e,t={}){const n=new Headers(t.headers||{});return r.apiToken&&n.set("Authorization",`Bearer ${r.apiToken}`),fetch(e,{...t,headers:n})}function De(){const e=new URL("/api/stream",window.location.origin);return r.apiToken&&e.searchParams.set("access_token",r.apiToken),e.toString()}function Me(e){const t=e.trim();r.apiToken=t,D.value=t,t?(window.localStorage.setItem(E,t),a("Stored API token for this device.")):(window.localStorage.removeItem(E),a("Cleared API token for this device.")),r.streamConnected=!1,U(),r.sessionStream&&(r.sessionStream.close(),r.sessionStream=null),F(),m("auth change"),r.selectedCwd&&v("auth change")}function je(){U(),r.streamReconnectTimer=window.setTimeout(()=>{F()},1500)}function U(){r.streamReconnectTimer&&(window.clearTimeout(r.streamReconnectTimer),r.streamReconnectTimer=null)}function Be(){const e=r.session;return!e||!e.active_thread_id?2200:e.pending_approvals?.length||e.active_turn_id?700:e.current_status&&e.current_status!=="idle"?1100:2200}function c(e,t){return`
    <span class="meta-chip">
      <strong>${o(e)}:</strong>
      <span>${o(t)}</span>
    </span>
  `}function Fe(e){return e?.security_mode==="managed"?"Managed":"Private"}function Ue(e){return e?.broker_can_read_content?e.audit_enabled?"Org-readable + audit":"Readable":e?.e2ee_enabled?"E2EE broker-blind":"Broker-blind"}function Je(e){if(!e?.broker_channel_id)return"Disabled";const t=e.broker_connected?"Connected":"Offline",n=s(e.broker_channel_id);return e.broker_peer_id?`${t} · ${n} · ${s(e.broker_peer_id)}`:`${t} · ${n}`}function Ye(e){const t=Array.isArray(e?.paired_devices)?e.paired_devices.length:0;return t===0?"None":`${t} paired`}function J(e){return e?new Date(e*1e3).toLocaleString([],{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):"unknown"}function Ke(e){return e==="command"?"Command":e}function b(e){return!e?.active_thread_id||!e.active_controller_device_id?!1:e.active_controller_device_id===r.deviceId}function Ve(e){return e?.active_thread_id?!e.active_controller_device_id||e.active_controller_device_id===r.deviceId:!1}function ie(e){return e?e===r.deviceId?`This device (${s(e)})`:s(e):"Unclaimed"}function s(e){return e?e.slice(0,8):"unknown"}function We(){const e=window.localStorage.getItem(Y);if(e)return e;const t=window.crypto?.randomUUID?.()?window.crypto.randomUUID():`device-${Date.now()}-${Math.random().toString(16).slice(2)}`;return window.localStorage.setItem(Y,t),t}function Ge(){return window.localStorage.getItem(E)?.trim()||""}function a(e){const t=new Date().toLocaleTimeString();q.textContent=`${t}  ${e}
${q.textContent}`.trim()}function o(e){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;")}
