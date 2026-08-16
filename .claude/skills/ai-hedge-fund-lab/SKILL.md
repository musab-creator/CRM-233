---
name: ai-hedge-fund-lab
description: Run and learn from the AI Hedge Fund project (virattt/ai-hedge-fund) — an educational multi-agent trading system. Use when the user wants to run aihf, backtest a mandate, understand its architecture (investor-persona alpha models, conviction blending, backtesting engine), or borrow its patterns for their own multi-agent or finance-adjacent systems. Educational only — never present its output as real investment advice.
---

# AI Hedge Fund Lab

Source: [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) (MIT). **Educational/research only — it does not trade, and its output is not investment advice.** Always say so when presenting results.

## Run it

```bash
# install once (any machine)
pipx install aihf        # or: uv tool install aihf

aihf                     # interactive app (TUI)
aihf mandate.yaml --tickers AAPL,MSFT,NVDA          # one cycle, prints record JSON
aihf mandate.yaml --tickers AAPL,MSFT --backtest --start 2025-01-01   # backtest
```

First run asks for keys and saves them to `~/.hedge-fund/.env`:
- `FINANCIAL_DATASETS_API_KEY` (prices/fundamentals — financialdatasets.ai)
- One LLM key: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `DEEPSEEK_API_KEY` / `XAI_API_KEY` / `KIMI_API_KEY`
- `--model claude-…` picks the reasoning model; quant models ignore it.

From a source clone: `poetry install && poetry run aihf` (tests: `poetry run pytest` — 175 pass, 38 skipped without API keys).

## Architecture worth stealing

1. **The fund is a spec, not code.** A mandate YAML defines the fund (strategy, constraints); the universe (tickers) is a *run-time input*. Config-as-entity makes everything backtestable and reproducible.
2. **Investor personas as pluggable alpha models.** Strategies (`hedge_fund/strategies/*.yaml`) blend persona models — e.g. `deep-value` = Graham (weight 2.0) + Buffett + Munger, `conviction_weighted` blend with a gross exposure target. Adding a strategy is data, not code.
3. **LLM agents and quant models behind one interface.** LLM-reasoning personas and pure-quant models produce the same signal shape, so the blender doesn't care which kind produced it.
4. **Point-in-time discipline.** `--date` caps what data models may see ("models only see data filed by this date") — the guard against look-ahead bias; any backtesting system you build should copy this.
5. **Deterministic pipeline around non-deterministic agents.** signals → conviction blend → risk/position sizing → portfolio record; the LLM only fills in the judgment step. Same shape as agentic coding harnesses.
6. **One cycle = one auditable record.** Each run emits a full JSON record (`--out`), so runs can be diffed, replayed, and regression-tested.

Package map (for source reading): `hedge_fund/fund` (mandate spec) · `strategies/` (persona blends) · `llm/` (multi-provider) · `features/` (factors) · `risk/` · `portfolio/` · `backtesting/engine.py` (rebalance loop) · `brokers/` (paper) · `tui/`.
