#!/usr/bin/env python3
"""DeepEdge two-agent autonomous loop (Strategist + Risk Officer).

A Strategist agent proposes a bet from the market data; a separate Risk
Officer agent reviews it against the historical calibration and the
Mandate limits, and can VETO. Only an approved decision is stored on
Walrus, hashed, enforced on-chain, and verified. Two AIs check each
other; the Move Mandate is the final hard rail.
"""
import json, os, sys, time, hashlib, subprocess, urllib.request

def notify_telegram(result):
    """Push a concise Markdown summary of the decision to Telegram, with the
    Walrus blob and a verify link. Alert-only and non-custodial -- it never
    touches funds, it just makes the agent's reasoning visible and checkable
    the moment it happens. Fails silently so it can never break the loop."""
    try:
        import os, urllib.request, urllib.parse
        token = os.environ.get("TELEGRAM_BOT_TOKEN")
        chat = os.environ.get("TELEGRAM_CHAT_ID")
        if not token or not chat:
            return

        def esc(s):
            # Escape MarkdownV2 reserved characters.
            for ch in r"_*[]()~`>#+-=|{}.!":
                s = s.replace(ch, "\\" + ch)
            return s

        steps = result.get("steps", [])
        outcome, market, fair, verdict, blob = "?", {}, None, "", None
        for s in steps:
            st = s.get("stage")
            if st == "observe":
                market = s.get("market", {})
                fair = s.get("fair", {}).get("up")
            elif st == "risk_officer":
                verdict = (s.get("review", {}) or {}).get("verdict", "")
            elif st == "walrus":
                blob = s.get("blob_id")
            elif st == "enforce":
                outcome = s.get("outcome", "?")

        icon = {"veto": "\U0001F6E1", "bet": "\u2705", "no_bet": "\u2796"}.get(outcome, "\u2139")
        asset = market.get("asset", "?")
        strike = market.get("strike_usd")

        # Short verdict: first sentence only, then escaped.
        short = verdict.split(". ")[0].strip() if verdict else ""
        if short and not short.endswith("."):
            short += "."
        if len(short) > 180:
            short = short[:177] + "..."

        lines = [f"{icon} *DeepEdge Agent \u2014 {esc(outcome.upper())}*", ""]
        if strike and fair is not None:
            lines.append(f"*{esc(asset)}* @ ${esc(f'{strike:,.0f}')}")
            lines.append(f"fair P\\(up\\): `{fair:.3f}`")
            lines.append("")
        if short:
            label = {"veto": "\U0001F6D1 *Risk Officer:* VETO",
                     "bet": "\u2705 *Approved \u2014 bet placed*",
                     "no_bet": "\u2796 *No bet*"}.get(outcome, "*Decision*")
            lines.append(label)
            lines.append(f"_{esc(short)}_")
            lines.append("")
        if blob:
            lines.append(f"\U0001F4DD Walrus `{esc(blob[:16])}\u2026`")
        lines.append("\U0001F50D Verify on the Ledger")

        text = "\n".join(lines)
        data = urllib.parse.urlencode({
            "chat_id": chat,
            "text": text,
            "parse_mode": "MarkdownV2",
            "disable_web_page_preview": "true",
        }).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendMessage", data=data)
        urllib.request.urlopen(req, timeout=10)
    except Exception:
        pass  # notifications must never break the loop


LEDGER_PATH = "/root/deepedge/decisions/ledger.jsonl"

def append_ledger(result):
    """Append the full cycle result as one JSON line (audit trail).
    Every decision -- bet, veto, or no_bet -- is preserved with its
    Walrus blob_id and sha256, so the agent's whole history is auditable."""
    try:
        import os, time as _t
        os.makedirs(os.path.dirname(LEDGER_PATH), exist_ok=True)
        with open(LEDGER_PATH, "a") as _f:
            _f.write(json.dumps({"ts": int(_t.time() * 1000), "result": result}) + "\n")
    except Exception:
        pass  # the ledger must never break the loop


API = 'http://localhost:3000'
PKG = '0xb82750b35a213320d5ad6204e7bce46493ae76340e2a018fd65fdca4ad08f34a'
MANDATE = '0x753fb2e637d42067aeea59df6044ddfeb37ac22c92f28c89a8ffc6e3a4635f3a'
WAL_PUB = 'https://publisher.walrus-testnet.walrus.space/v1/blobs?epochs=1'
WAL_AGG = 'https://aggregator.walrus-testnet.walrus.space/v1/blobs/'
KEY = os.environ.get('ANTHROPIC_API_KEY')
MODEL = 'claude-sonnet-4-5-20250929'
PER_BET_CAP = 2000000
TOTAL_BUDGET = 10000000

def get(path):
    with urllib.request.urlopen(API + path, timeout=15) as r:
        return json.load(r)

def claude(system, user, max_tokens=600):
    """Call Claude and return the raw text. Bare call, no JSON parsing."""
    body = json.dumps({
        'model': MODEL, 'max_tokens': max_tokens,
        'system': system,
        'messages': [{'role': 'user', 'content': user}],
    }).encode()
    req = urllib.request.Request('https://api.anthropic.com/v1/messages',
        data=body, headers={'x-api-key': KEY,
        'anthropic-version': '2023-06-01', 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        txt = json.load(r)['content'][0]['text']
    return txt.strip().removeprefix('```json').removeprefix('```').removesuffix('```').strip()


def claude_json(system, user, max_tokens=600, retries=2):
    """Call Claude expecting a JSON object back, and parse it robustly.

    LLMs occasionally return an empty completion, a prose preamble, or a
    truncated response, any of which break a naive json.loads. We strip
    fences, slice out the outermost {...} object, and retry a couple of
    times before giving up. This keeps a single flaky completion from
    aborting an entire decision cycle."""
    last_err = None
    for attempt in range(retries + 1):
        try:
            txt = claude(system, user, max_tokens)
            if not txt:
                raise ValueError("empty completion")
            # Try direct parse first.
            try:
                return json.loads(txt)
            except json.JSONDecodeError:
                pass
            # Slice the outermost JSON object and parse that.
            start = txt.find("{")
            end = txt.rfind("}")
            if start != -1 and end != -1 and end > start:
                return json.loads(txt[start:end + 1])
            raise ValueError("no JSON object in completion: " + txt[:80])
        except Exception as e:
            last_err = e
            continue
    raise ValueError(f"claude_json failed after {retries + 1} attempts: {last_err}")

# ---- observe ----
def fetch_cross_venue():
    """Fetch the cross-venue vol reference: Deribit DVOL, Binance realized
    vol, the vol-risk-premium, and how Predict's ATM IV compares. If Predict
    is far out of line with the rest of the market, that is a sign the
    on-chain surface may be mispriced. Returns None on failure."""
    try:
        d = get('/api/cross-venue')
        if not d:
            return None
        return {
            "deribit_dvol": d.get("deribit_dvol"),
            "binance_realized_vol": d.get("binance_realized_vol"),
            "vol_risk_premium": d.get("vol_risk_premium"),
            "predict_atm_iv": d.get("predict_atm_iv"),
            "predict_vs_deribit": d.get("predict_vs_deribit"),
            "predict_richness": d.get("predict_richness"),
        }
    except Exception:
        return None

def fetch_vault_health():
    """Fetch the PLP vault's solvency grade. The vault underwrites every
    position, so a stressed vault is a reason for the Risk Officer to be
    more conservative regardless of the edge. Returns None on failure."""
    try:
        d = get('/api/vault/health')
        h = d.get('health')
        if not h:
            return None
        return {
            "grade": h.get("grade"),
            "max_payout_utilization": h.get("max_payout_utilization"),
            "breach_headroom_pct": h.get("breach_headroom_pct"),
            "withdrawal_headroom_pct": h.get("withdrawal_headroom_pct"),
        }
    except Exception:
        return None

def fetch_density(oid):
    """Fetch the Breeden-Litzenberger risk-neutral density summary for a
    market: the most-likely settlement (mode), the density-implied P(up),
    and the 90% range. Returns None if unavailable so the agents degrade
    gracefully."""
    try:
        d = get(f'/api/markets/{oid}/density')
        g = d.get('grid')
        if not g:
            return None
        return {
            "mode_usd": g.get("mode_usd"),
            "prob_up": g.get("prob_up"),
            "p05_usd": g.get("p05_usd"),
            "p95_usd": g.get("p95_usd"),
        }
    except Exception:
        return None

def observe(oid=None):
    cal = get('/api/backtest/calibration')
    if oid is None:
        # Pick the market with the largest edge: the ATM fair probability
        # furthest from 0.50. That is where a Strategist sees the most to
        # gain -- and, on this testnet, often exactly the 0.40-0.50 bucket
        # where calibration shows the market is least trustworthy. The agent
        # selects on edge; the Risk Officer then judges whether that edge is
        # real. No market is hard-coded.
        mk = get('/api/markets')
        actives = [m for m in mk['markets'] if m.get('status') == 'active']
        if not actives:
            sys.exit('No active markets')
        best = None
        best_dist = -1.0
        best_near = None
        for m in actives:
            try:
                e = get(f"/api/markets/{m['oracle_id']}/edges")
                g = e['edge_grid']
                # Skip markets whose on-chain price is stale (>6h): a frozen
                # spot produces a fake edge. The agent only trades on fresh data.
                if g.get('price_age_seconds', 10**9) > 21600:
                    continue
                a = g['atm_strike_usd']
                nr = min(g['strikes'], key=lambda s: abs(s['strike_usd'] - a))
                dist = abs(nr['up']['fair'] - 0.5)
                if dist > best_dist:
                    best_dist, best, best_near = dist, e, nr
            except Exception:
                continue
        if best is None:
            sys.exit('No market with usable edges')
        sel_oid = best['oracle']['oracle_id'] if 'oracle_id' in best['oracle'] else actives[0]['oracle_id']
        dens = fetch_density(sel_oid)
        vault = fetch_vault_health()
        xv = fetch_cross_venue()
        return sel_oid, best['oracle'], best_near, cal, dens, vault, xv
    edges = get(f'/api/markets/{oid}/edges')
    grid = edges['edge_grid']
    atm = grid['atm_strike_usd']
    near = min(grid['strikes'], key=lambda s: abs(s['strike_usd'] - atm))
    dens = fetch_density(oid)
    vault = fetch_vault_health()
    xv = fetch_cross_venue()
    return oid, edges['oracle'], near, cal, dens, vault, xv

def bucket_for(cal, prob):
    for b in cal['buckets']:
        if b['bucket_low'] <= prob < b['bucket_high']:
            return b
    return None

# ---- Agent 1: Strategist ----
def strategist(oracle, near, cal, dens=None):
    fair_up = near['up']['fair']
    fair_down = near['down']['fair']
    sys_p = ('You are the STRATEGIST for a DeepBook Predict trading agent. '
             'You propose bets to maximize expected value. Be decisive but '
             'honest. Respond ONLY with JSON, no fences.')
    u = []
    u.append(f"Market {oracle['underlying_asset']} expiry {oracle['expiry_iso']}")
    u.append(f"strike {near['strike_usd']}, model fair P(up) {fair_up:.4f}, P(down) {fair_down:.4f}")
    if dens and dens.get("prob_up") is not None:
        u.append(f"Risk-neutral density (Breeden-Litzenberger from the SVI smile): most-likely settlement ${dens['mode_usd']:,.0f}, density-implied P(up) {dens['prob_up']:.4f}, 90% range ${dens['p05_usd']:,.0f}-${dens['p95_usd']:,.0f}. Check whether the strike sits inside this range and whether density P(up) agrees with the model fair P(up).")
    u.append(f"per-bet cap {PER_BET_CAP} (1e6=1 DUSDC), budget {TOTAL_BUDGET}.")
    u.append('Propose a bet. JSON:')
    u.append('{"action":"BET_UP|BET_DOWN|NO_BET","size":<int micro-DUSDC <= cap>,"thesis":"<why, 2 sentences>"}')
    return claude_json(sys_p, chr(10).join(u))

# ---- Agent 2: Risk Officer ----
def risk_officer(proposal, oracle, near, cal, dens=None, vault=None, xv=None):
    fair_up = near['up']['fair']
    b = bucket_for(cal, fair_up)
    sys_p = ('You are the RISK OFFICER for a DeepBook Predict trading agent. '
             'Your job is to PROTECT capital. Review the Strategist proposal '
             'against historical calibration (the model is systematically '
             'optimistic) and the mandate limits. You may VETO or cut size. '
             'Respond ONLY with JSON, no fences.')
    u = []
    u.append('STRATEGIST PROPOSAL: ' + json.dumps(proposal))
    u.append(f"model fair P(up) {fair_up:.4f}")
    u.append(f"CALIBRATION overall: implied {cal['overall_avg_implied']:.3f} vs actual {cal['overall_win_rate']:.3f}, ROI {cal['overall_avg_roi']:.3f}")
    if b:
        u.append(f"this bucket {b['bucket_low']:.2f}-{b['bucket_high']:.2f}: implied {b['avg_implied_prob']:.3f} actual {b['actual_win_rate']:.3f} gap {b['calibration_gap']:.3f} roi {b['avg_roi']:.3f}")
    if dens and dens.get("prob_up") is not None:
        u.append(f"INDEPENDENT CROSS-CHECK -- risk-neutral density (Breeden-Litzenberger): density-implied P(up) {dens['prob_up']:.4f} vs model fair P(up) {fair_up:.4f}; 90% settlement range ${dens['p05_usd']:,.0f}-${dens['p95_usd']:,.0f}. If the density-implied P(up) diverges materially from the model fair, or the strike sits in the tail of the density, treat the claimed edge with extra suspicion.")
    if vault and vault.get("grade"):
        u.append(f"VAULT SOLVENCY (the PLP vault underwrites this position): grade {vault['grade']}, max-payout utilization {vault['max_payout_utilization']*100:.0f}%, breach headroom {vault['breach_headroom_pct']:.0f}%. If the vault is AMBER or RED, be more conservative: a stressed counterparty is a reason to cut size or veto even when the edge looks acceptable.")
    if xv and xv.get("predict_richness"):
        dvol = xv.get("deribit_dvol")
        piv = xv.get("predict_atm_iv")
        vrp = xv.get("vol_risk_premium")
        u.append(f"CROSS-VENUE VOL CHECK: Predict ATM IV {piv:.0f}% vs Deribit DVOL {dvol:.0f}% -> Predict is {xv['predict_richness']}. Vol-risk-premium (Deribit implied - Binance realized) {vrp:+.0f}%. If Predict is far 'rich' or 'cheap' versus Deribit, the on-chain surface may be mispriced and the model's fair value less trustworthy; weigh that in the risk decision." if (dvol and piv and vrp is not None) else "")
    u.append(f"limits: per-bet cap {PER_BET_CAP}, budget {TOTAL_BUDGET}.")
    u.append('Review. JSON:')
    u.append('{"approved":true|false,"adjusted_size":<int micro-DUSDC, 0 if vetoed>,"calibration_adjusted_prob":<0..1>,"verdict":"<reasoning, 2-3 sentences>"}')
    return claude_json(sys_p, chr(10).join(u))

# ---- Walrus + verify ----
def store_walrus(b):
    req = urllib.request.Request(WAL_PUB, data=b, method='PUT')
    with urllib.request.urlopen(req, timeout=60) as r:
        resp = json.load(r)
    return (resp.get('newlyCreated', {}).get('blobObject', {}).get('blobId')
            or resp.get('alreadyCertified', {}).get('blobId'))

def verify(blob_id, expected_hex, retries=6, wait=5):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(WAL_AGG + blob_id,
                headers={'User-Agent': 'deepedge-loop2/1.0'})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            return hashlib.sha256(data).hexdigest() == expected_hex
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (403, 404, 425):
                print(f'    (aggregator not ready, retry {i+1}/{retries})')
                time.sleep(wait); continue
            raise
    print(f'    verify gave up: {last}')
    return False

def enforce_and_record(amount, hash_hex, blob_id):
    cmd = ['sui', 'client', 'ptb',
        '--move-call', f'{PKG}::mandate::authorize_with_decision',
        f'@{MANDATE}', f'{amount}', f'"{hash_hex}"', f'"{blob_id}"',
        '--assign', 'receipt',
        '--move-call', f'{PKG}::mandate::record_decision_and_consume',
        f'@{MANDATE}', 'receipt', '--gas-budget', '50000000']
    return subprocess.run(cmd, capture_output=True, text=True)

def run_cycle_json():
    """Run one 2-agent cycle and return a structured dict (for the API)."""
    import io, contextlib
    steps = []
    result = {"ok": False, "steps": steps}
    try:
        # 1. observe
        oid, oracle, near, cal, dens, vault, xv = observe(None)
        steps.append({"stage": "observe", "status": "done",
            "market": {"asset": oracle["underlying_asset"],
                       "expiry": oracle["expiry_iso"],
                       "strike_usd": near["strike_usd"],
                       "oracle_id": oid},
            "fair": {"up": near["up"]["fair"], "down": near["down"]["fair"]},
            "density": dens,
            "vault_health": vault,
            "cross_venue": xv})

        # 2. strategist
        prop = strategist(oracle, near, cal, dens)
        steps.append({"stage": "strategist", "status": "done", "proposal": prop})

        # 3. risk officer
        review = risk_officer(prop, oracle, near, cal, dens, vault, xv)
        steps.append({"stage": "risk_officer", "status": "done", "review": review})

        approved = bool(review.get("approved"))
        size = int(review.get("adjusted_size", 0)) if approved else 0
        if size > PER_BET_CAP:
            size = PER_BET_CAP

        # 4. decision record + walrus
        record = {
            "market": {"oracle_id": oid, "asset": oracle["underlying_asset"],
                       "expiry": oracle["expiry_iso"], "strike_usd": near["strike_usd"]},
            "fair": {"up": near["up"]["fair"], "down": near["down"]["fair"]},
            "strategist": prop, "risk_officer": review,
            "final_size": size, "model": MODEL, "ts": int(time.time())}
        rb = json.dumps(record, sort_keys=True, separators=(",", ":")).encode()
        hash_hex = hashlib.sha256(rb).hexdigest()
        blob_id = store_walrus(rb)
        steps.append({"stage": "walrus", "status": "done",
            "blob_id": blob_id, "sha256": hash_hex})

        # 5. verify
        ok = verify(blob_id, hash_hex)
        steps.append({"stage": "verify", "status": "done", "match": ok})

        # 6. enforce + record -- three distinct outcomes
        if approved and size > 0:
            # (A) approved with a real size -> bet on-chain
            res = enforce_and_record(size, hash_hex, blob_id)
            if res.returncode == 0:
                dg = [l.strip() for l in res.stdout.splitlines() if "Transaction Digest" in l]
                digest = dg[0].split(":")[-1].strip() if dg else ""
                steps.append({"stage": "enforce", "status": "done",
                    "outcome": "bet", "spent_amount": size, "digest": digest})
            else:
                steps.append({"stage": "enforce", "status": "error",
                    "outcome": "error", "error": res.stderr[-300:]})
        elif not approved:
            # (B) Risk Officer vetoed the Strategist's proposal
            steps.append({"stage": "enforce", "status": "done",
                "outcome": "veto",
                "reason": review.get("verdict", "Risk Officer vetoed the proposal")})
        else:
            # (C) approved, but the proposal itself was NO_BET (no edge)
            steps.append({"stage": "enforce", "status": "done",
                "outcome": "no_bet",
                "reason": review.get("verdict", "Both agents agreed there is no edge")})

        result["ok"] = True
        result["approved"] = approved
        result["final_size"] = size
    except Exception as e:
        result["error"] = str(e)
    # Only record complete, successful cycles. A cycle that died mid-way
    # (e.g. a transient 502 while the backend was restarting) has ok=False
    # and no steps; recording it would put a broken '?' row in the ledger.
    if result.get("ok") and result.get("steps"):
        append_ledger(result)
        notify_telegram(result)
    return result


def main():
    if not KEY:
        print(json.dumps({"ok": False, "error": "ANTHROPIC_API_KEY not set"}))
        return
    if len(sys.argv) > 1 and sys.argv[1] == "--json":
        print(json.dumps(run_cycle_json()))
        return
    # original human-readable mode preserved below
    _main_human()


def _main_human():
    if not KEY:
        sys.exit('source ~/.anthropic_key first')
    oid_arg = sys.argv[1] if len(sys.argv) > 1 else None

    print('== 1. OBSERVE ==')
    oid, oracle, near, cal, dens, vault, xv = observe(oid_arg)
    print(f"  {oracle['underlying_asset']} {oracle['expiry_iso']} strike {near['strike_usd']}")

    print('== 2. STRATEGIST proposes ==')
    prop = strategist(oracle, near, cal, dens)
    print('  ' + json.dumps(prop, ensure_ascii=False))

    print('== 3. RISK OFFICER reviews ==')
    review = risk_officer(prop, oracle, near, cal, dens, vault, xv)
    print('  ' + json.dumps(review, ensure_ascii=False))

    approved = bool(review.get('approved'))
    size = int(review.get('adjusted_size', 0)) if approved else 0
    # safety clamp to the on-chain cap
    if size > PER_BET_CAP:
        size = PER_BET_CAP

    print('== 4. DECISION RECORD + WALRUS ==')
    record = {
        'market': {'oracle_id': oid, 'asset': oracle['underlying_asset'],
                   'expiry': oracle['expiry_iso'], 'strike_usd': near['strike_usd']},
        'fair': {'up': near['up']['fair'], 'down': near['down']['fair']},
        'strategist': prop,
        'risk_officer': review,
        'final_size': size,
        'model': MODEL, 'ts': int(time.time()),
    }
    rb = json.dumps(record, sort_keys=True, separators=(',', ':')).encode()
    hash_hex = hashlib.sha256(rb).hexdigest()
    blob_id = store_walrus(rb)
    print(f'  sha256 {hash_hex}')
    print(f'  blobId {blob_id}')

    print('== 5. VERIFY ==')
    print(f"  hashes back: {verify(blob_id, hash_hex)}")

    print('== 6. ENFORCE + RECORD ==')
    if approved and size > 0:
        res = enforce_and_record(size, hash_hex, blob_id)
        if res.returncode == 0:
            dg = [l.strip() for l in res.stdout.splitlines() if 'Transaction Digest' in l]
            print(f'  recorded on-chain size={size}; ' + (dg[0] if dg else ''))
        else:
            print('  FAILED:'); print(res.stderr[-400:])
    else:
        print(f'  Risk Officer VETOED (or NO_BET). Reasoning stored on Walrus,')
        print(f'  no on-chain spend. This is the two-agent check working.')
    print('== CYCLE COMPLETE ==')

if __name__ == '__main__':
    main()
