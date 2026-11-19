// Antique Books Portal ⇄ Dyntechs (Odoo 15) sync — YML Leather
// Push: books sent from the portal -> x_antique_book cards (Expected). Edits pushed until F enters measurements.
// Pull: card number (x_name), lock (measurements entered), status (invoiced -> History).
// Secrets: ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_KEY (login + API key entered by the owner). Throttled: max one run per 2 minutes.
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const OURL = Deno.env.get("ODOO_URL")!, DB = Deno.env.get("ODOO_DB")!;
const LOGIN = Deno.env.get("ODOO_LOGIN")!, KEY = Deno.env.get("ODOO_KEY")!;

async function rpc(service: string, method: string, args: unknown[]) {
  const r = await fetch(OURL + "/jsonrpc", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.data?.message || j.error.message);
  return j.result;
}
let uid = 0;
const kw = (model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) =>
  rpc("object", "execute_kw", [DB, uid, KEY, model, method, args, kwargs]);

const WT: Record<string, string> = {
  "Level 1": "l1", "Level 2": "l2", "Level 3": "l3", "Level 4": "l4",
  "Half leather": "half", "Stickers": "labels", "New spine": "spine", "Box": "box",
};
const DONE_STATES = ["invoiced", "returned"];
// readable Dyntechs states for the YML tag in the portal (customers don't see it)
const STATE_LABEL: Record<string, string> = {
  expected: "Expected (not received)", received: "Received", shelf: "On shelf", asus: "Asus", a: "Station A", b: "Station B",
  c: "Station C", g: "Station G", finish: "Finishing", ready: "Ready", invoiced: "Invoiced", returned: "Returned",
};
const TXT = ["x_spine_top", "x_spine_middle", "x_spine_bottom", "x_front_text", "x_front_name"];
const TXT_LABEL: Record<string, string> = { x_spine_top: "spine top", x_spine_middle: "spine middle", x_spine_bottom: "spine bottom", x_front_text: "front text", x_front_name: "name line" };

function sleevesPrice(n: number) { return !n ? 0 : n <= 4 ? 75 : n <= 25 ? 150 : 200; }

// Set name in Dyntechs must be unique (Stamp Preview groups cards by x_set_group): "<set name> · <list> #<first portal id of the set>"
// SK = set key per portal set (profile|set name|volumes) -> lowest book id; filled at the start of each run
let SK: Record<string, number> = {};
const skOf = (b: any) => `${b.profile_id}|${b.set_name}|${b.vol_total || 0}`;
// deno-lint-ignore no-explicit-any
function setKey(b: any, p: any) { return b.set_name ? `${b.set_name} · ${p.dyn_source || p.name} #${SK[skOf(b)] || b.id}` : false; }

// deno-lint-ignore no-explicit-any
function cardVals(b: any, p: any) {
  const notes: string[] = [];
  if (b.notes) notes.push(b.notes);
  if (b.is_folder) notes.push(`FOLDER: paper ${b.paper_w ?? "?"}×${b.paper_h ?? "?"} cm, ${b.sleeves ?? 0} plastic sleeves ($${sleevesPrice(b.sleeves)})`);
  if (b.is_box) notes.push(`BOX (price by quote): ${[b.box_w, b.box_h, b.box_d].map((x: number) => x ?? "?").join("×")} cm${b.box_note ? " – " + b.box_note : ""}`);
  if (b.ref) notes.push(`Customer ref: ${b.ref}`);
  if (b.set_name && b.vol) notes.push(`Set: ${b.set_name} – vol ${b.vol}${b.vol_total ? "/" + b.vol_total : ""}`);
  notes.push(`From portal #${b.id}`);
  // letter per list; a list may use its own letters for Half leather / Stickers (profiles.prefix_half / prefix_labels)
  let prefix = p.dyn_prefix || "D";
  if (b.level === "Half leather" && p.prefix_half) prefix = p.prefix_half;
  if (b.level === "Stickers" && p.prefix_labels) prefix = p.prefix_labels;
  return {
    x_partner_id: p.dyn_partner_id, x_source: p.dyn_source, x_prefix: prefix,
    x_spine_top: b.spine_top || false, x_spine_middle: b.spine_mid || false, x_spine_bottom: b.spine_bot || false,
    x_front_text: b.front_text || false, x_front_name: b.name_line || false,
    x_work_type: WT[b.level] || false, x_set_group: setKey(b, p),
    x_comments: notes.join("\n"), x_sheet_ref: `Portal #${b.id}`,
  };
}

// Fields the customer controls in the portal. On an update only the ones the CUSTOMER changed are written,
// so whatever the office changed on the card is kept. x_comments is never overwritten – changes are appended.
const UPD = ["x_partner_id", "x_source", "x_spine_top", "x_spine_middle", "x_spine_bottom", "x_front_text", "x_front_name", "x_work_type", "x_set_group"];
const nv = (x: unknown) => (Array.isArray(x) ? x[0] : x) === false || x == null ? "" : String(Array.isArray(x) ? x[0] : x);
const today = () => new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric" });

Deno.serve(async (req) => {
  const log: string[] = [];
  const { data: last } = await sb.from("sync_runs").select("started_at").order("started_at", { ascending: false }).limit(1);
  if (last?.[0] && Date.now() - new Date(last[0].started_at).getTime() < 120000) return new Response(JSON.stringify({ ok: true, skipped: "ran less than 2 min ago" }), { headers: { "Content-Type": "application/json" } });
  const { data: run } = await sb.from("sync_runs").insert({}).select("id").single();
  try {
    uid = await rpc("common", "authenticate", [DB, LOGIN, KEY, {}]);
    if (!uid) throw new Error("Dyntechs login failed");
    const { data: profs } = await sb.from("profiles").select("*");
    // deno-lint-ignore no-explicit-any
    const P: Record<string, any> = Object.fromEntries((profs || []).map((p) => [p.id, p]));
    { const { data: ss } = await sb.from("books").select("id,profile_id,set_name,vol_total").eq("origin", "portal").not("set_name", "is", null).limit(5000);
      SK = {}; for (const x of ss || []) { const k = skOf(x); if (!SK[k] || x.id < SK[k]) SK[k] = x.id; } }

    // ---- BASELINE: what was last sent to each card (dyn_pushed); filled once for cards created before 11/15 ----
    const { data: nob } = await sb.from("books").select("*").eq("origin", "portal").not("dyn_id", "is", null).is("dyn_pushed", null).neq("dyn_state", "pending").limit(500);
    for (const b of nob || []) { const p = P[b.profile_id]; if (p) await sb.from("books").update({ dyn_pushed: cardVals(b, p) }).eq("id", b.id); }

    // ---- PUSH ----
    const { data: pend } = await sb.from("books").select("*").eq("origin", "portal").eq("sent", true).eq("dyn_state", "pending").limit(200);
    for (const b of pend || []) {
      const p = P[b.profile_id];
      if (!p?.dyn_partner_id) { await sb.from("books").update({ dyn_state: "error", dyn_error: "profile not linked to Dyntechs" }).eq("id", b.id); continue; }
      try {
        if (b.dyn_id) {
          const [c] = await kw("x_antique_book", "search_read", [[["id", "=", b.dyn_id]]], { fields: ["x_width_cm", "x_height_cm", "x_seq", "x_prefix", "x_comments", "x_stamp_edited", ...UPD] });
          if (!c) {   // card was deleted / merged in Dyntechs -> don't re-create it
            await sb.from("books").update({ dyn_gone: true, dyn_state: "error", dyn_error: "Dyntechs card deleted or merged – not re-created", hist_detail: "⚠ Dyntechs card deleted/merged – not re-created" }).eq("id", b.id);
            log.push(`#${b.id} card ${b.dyn_id} gone`); continue;
          }
          if (c && c.x_width_cm && c.x_height_cm) {
            await sb.from("books").update({ dyn_state: "synced", locked: true, dyn_error: "edit after measurements – not sent" }).eq("id", b.id);
            log.push(`#${b.id} locked, edit not sent`); continue;
          }
          const v: Record<string, unknown> = cardVals(b, p);
          const base: Record<string, unknown> = b.dyn_pushed || c || {};   // no baseline yet -> compare with the card itself
          const w: Record<string, unknown> = {};
          for (const k of UPD) if (nv(v[k]) !== nv(base[k])) w[k] = v[k];
          if (!v.x_set_group) delete w.x_set_group;   // never clear a set the office grouped in Dyntechs
          // moved to another customer in the portal: new letter; if it already has a number -> office must print a new sticker (action 710 renumbers)
          const moved = c && c.x_partner_id && c.x_partner_id[0] !== p.dyn_partner_id;
          // work type changed in the portal (e.g. Level 2 -> Half leather) and this list uses another letter for it: same as a move
          const retyped = "x_work_type" in w;
          if ((moved || retyped) && v.x_prefix !== c.x_prefix) { w.x_prefix = v.x_prefix; if (c.x_seq) { w.x_reprint = true; log.push(`#${b.id} ${moved ? "moved" : "work type changed"} – sticker to reprint`); } }
          // notes: append only what changed, keep everything the office wrote
          const oldL = String(base.x_comments || "").split("\n"), newL = String(v.x_comments || "").split("\n");
          const added = newL.filter((l) => l && !oldL.includes(l)), removed = oldL.filter((l) => l && !newL.includes(l) && !l.startsWith("Portal update"));
          const extra: string[] = [];
          if (added.length || removed.length) extra.push(`Portal update ${today()}: ` + [...added, ...removed.map((r) => "(removed) " + r)].join(" · "));
          const txt = TXT.filter((k) => k in w);
          if (txt.length && c.x_stamp_edited) { extra.push(`Portal update ${today()}: customer changed text AFTER office edit (${txt.map((k) => TXT_LABEL[k]).join(", ")})`); log.push(`#${b.id} text changed after stamp edit`); }
          if (extra.length) w.x_comments = (c.x_comments ? c.x_comments + "\n" : "") + extra.join("\n");
          if (Object.keys(w).length) await kw("x_antique_book", "write", [[b.dyn_id], w]);
          await sb.from("books").update({ dyn_pushed: v }).eq("id", b.id);
          log.push(`#${b.id} updated card ${b.dyn_id}: ${Object.keys(w).join(",") || "no change"}`);
        } else {
          const v0 = cardVals(b, p);
          const id = await kw("x_antique_book", "create", [{ ...v0, x_priority: !!b.priority, x_state: "expected", x_name: "(not received)" }]);
          await sb.from("books").update({ dyn_id: id, dyn_pushed: v0 }).eq("id", b.id);
          log.push(`#${b.id} -> card ${id}`);
        }
        await sb.from("books").update({ dyn_state: "synced", dyn_error: null }).eq("id", b.id);
      } catch (e) {
        await sb.from("books").update({ dyn_state: "error", dyn_error: String(e).slice(0, 300) }).eq("id", b.id);
        log.push(`#${b.id} ERROR ${e}`);
      }
    }

    // ---- SET NAMES: keep x_set_group = unique set key on every card of a portal set (also measured / done cards; only this field) ----
    { const { data: sb2 } = await sb.from("books").select("id,profile_id,set_name,vol_total,dyn_id,dyn_pushed").eq("origin", "portal").not("set_name", "is", null).not("dyn_id", "is", null).eq("dyn_gone", false).limit(2000);
      const G: Record<string, { key: string; rows: any[] }> = {};   // deno-lint-ignore no-explicit-any
      for (const b of sb2 || []) { const p = P[b.profile_id]; if (!p) continue; const key = setKey(b, p) as string;
        if ((b.dyn_pushed?.x_set_group || "") === key) continue; (G[key] = G[key] || { key, rows: [] }).rows.push(b); }
      for (const g of Object.values(G).slice(0, 40)) {
        try {
          await kw("x_antique_book", "write", [g.rows.map((b) => b.dyn_id), { x_set_group: g.key }]);
          for (const b of g.rows) await sb.from("books").update({ dyn_pushed: { ...(b.dyn_pushed || {}), x_set_group: g.key } }).eq("id", b.id);
          log.push(`set "${g.key}": ${g.rows.length} cards`);
        } catch (e) { log.push(`set "${g.key}" ERROR ${e}`); }
      } }

    // ---- SHEET ROWS (all customers) in work without a card -> create an Expected card, so everything in the portal is in Dyntechs ----
    const { data: sh } = await sb.from("books").select("*").eq("origin", "sheet").eq("hist_status", "in_work").is("dyn_id", null).eq("dyn_gone", false).limit(100);
    for (const b of sh || []) {
      const p = P[b.profile_id];
      if (!p?.dyn_partner_id) continue;
      try {
        if (b.book_no) {   // already has a number: if a card with that number exists -> just link it
          const ex = await kw("x_antique_book", "search_read", [[["x_name", "=", b.book_no.split(/[–-]/)[0]]]], { fields: ["id"], limit: 1 });
          if (ex.length) { await sb.from("books").update({ dyn_id: ex[0].id }).eq("id", b.id); log.push(`sheet #${b.id} linked to card ${ex[0].id}`); continue; }
        }
        const id = await kw("x_antique_book", "create", [{ ...cardVals(b, p), x_sheet_ref: b.sheet_ref || `Portal #${b.id}`, x_priority: !!b.priority, x_state: "expected", x_name: "(not received)" }]);
        await sb.from("books").update({ dyn_id: id }).eq("id", b.id);
        log.push(`sheet #${b.id} -> card ${id}`);
      } catch (e) { log.push(`sheet #${b.id} ERROR ${e}`); }
    }

    // ---- FILES (portal 📎) -> ir.attachment on the Dyntechs card. Only adds; never deletes anything in Dyntechs ----
    const { data: att } = await sb.from("book_files").select("id,book_id,path,name,mime").is("dyn_att_id", null).order("id").limit(30);
    if (att?.length) {
      const { data: bk } = await sb.from("books").select("id,dyn_id,dyn_gone").in("id", [...new Set(att.map((a) => a.book_id))]);
      // deno-lint-ignore no-explicit-any
      const D: Record<string, any> = Object.fromEntries((bk || []).map((x) => [x.id, x]));
      for (const a of att) {
        const b = D[a.book_id];
        if (!b?.dyn_id || b.dyn_gone) continue;   // no card yet (book not sent) -> next run
        try {
          const { data: blob, error } = await sb.storage.from("book-files").download(a.path);
          if (error || !blob) throw error || new Error("download failed");
          const u8 = new Uint8Array(await blob.arrayBuffer());
          let bin = ""; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
          const attId = await kw("ir.attachment", "create", [{ name: a.name, datas: btoa(bin), res_model: "x_antique_book", res_id: b.dyn_id, mimetype: a.mime || "application/octet-stream" }]);
          await sb.from("book_files").update({ dyn_att_id: attId }).eq("id", a.id);
          log.push(`file #${a.id} -> card ${b.dyn_id} (attachment ${attId})`);
        } catch (e) { log.push(`file #${a.id} ERROR ${e}`); }
      }
    }

    // ---- PRIORITY (portal "High priority" button -> x_priority on the card) ----
    const { data: pr } = await sb.from("books").select("id,dyn_id,priority,dyn_priority").not("dyn_id", "is", null).eq("dyn_gone", false).or("priority.eq.true,dyn_priority.eq.true").limit(1000);
    for (const on of [true, false]) {
      const rows = (pr || []).filter((b) => !!b.priority === on && !!b.dyn_priority !== on);
      if (!rows.length) continue;
      try {
        await kw("x_antique_book", "write", [rows.map((b) => b.dyn_id), { x_priority: on }]);
        await sb.from("books").update({ dyn_priority: on }).in("id", rows.map((b) => b.id));
        log.push(`priority ${on ? "on" : "off"}: ${rows.length}`);
      } catch (e) { log.push(`priority ERROR ${e}`); }
    }

    // ---- PULL ----
    const { data: open } = await sb.from("books").select("id,origin,dyn_id,sheet_ref,book_no,locked,hist_status,hist_detail,received_on").eq("dyn_gone", false)
      .or("and(origin.eq.portal,sent.eq.true),and(origin.eq.sheet,hist_status.eq.in_work)").limit(1000);
    const byId = (open || []).filter((b) => b.dyn_id);
    const byRef = (open || []).filter((b) => !b.dyn_id && b.sheet_ref);
    const F = ["x_name", "x_state", "x_width_cm", "x_height_cm", "x_sheet_ref", "x_received_date"];
    // search_read (not read) so a deleted card doesn't break the whole pull; missing cards are marked below
    const cards = byId.length ? await kw("x_antique_book", "search_read", [[["id", "in", byId.map((b) => b.dyn_id)]]], { fields: F }) : [];
    const refCards = byRef.length ? await kw("x_antique_book", "search_read", [[["x_sheet_ref", "in", byRef.map((b) => b.sheet_ref)]]], { fields: F }) : [];
    // deno-lint-ignore no-explicit-any
    const C: Record<string, any> = {};
    for (const c of cards) C["id" + c.id] = c;
    for (const c of refCards) if (!C["ref" + c.x_sheet_ref]) C["ref" + c.x_sheet_ref] = c;
    let changed = 0, gone = 0;
    for (const b of open || []) {
      const c = b.dyn_id ? C["id" + b.dyn_id] : C["ref" + b.sheet_ref];
      if (!c) {
        if (b.dyn_id) { await sb.from("books").update({ dyn_gone: true, hist_detail: "⚠ Dyntechs card deleted/merged – not re-created" }).eq("id", b.id); gone++; }
        continue;
      }
      const no = c.x_name && c.x_name !== "(not received)" ? c.x_name : null;
      const done = DONE_STATES.includes(c.x_state);
      const upd: Record<string, unknown> = {
        book_no: no ?? b.book_no,
        locked: !!(c.x_width_cm && c.x_height_cm) || done,
        hist_status: done ? "done" : "in_work",
        hist_detail: done ? (c.x_state === "returned" ? "Returned" : "Invoiced") : `Dyntechs: ${STATE_LABEL[c.x_state] || c.x_state}${no ? " · " + no : ""}`,
        received_on: c.x_received_date || null,
      };
      if (!b.dyn_id) upd.dyn_id = c.id;   // sheet rows: remember the card (needed for priority)
      if (b.origin === "sheet") upd.locked = true; // sheet rows are always locked (DB trigger)
      if (upd.book_no !== b.book_no || upd.locked !== b.locked || upd.hist_status !== b.hist_status || upd.received_on !== (b.received_on ?? null) || upd.hist_detail !== b.hist_detail || upd.dyn_id) {
        await sb.from("books").update(upd).eq("id", b.id); changed++;
      }
    }
    log.push(`pull: ${changed} updated of ${(open || []).length}${gone ? ` · ${gone} cards gone` : ""}`);
    if (run) await sb.from("sync_runs").update({ ok: true, log: log.join("\n") }).eq("id", run.id);
    return new Response(JSON.stringify({ ok: true, log }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    if (run) await sb.from("sync_runs").update({ ok: false, log: (log.concat(String(e))).join("\n") }).eq("id", run.id);
    return new Response(JSON.stringify({ ok: false, error: String(e), log }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
