# Source register and operator setup

Start on Node 24 with `npm ci`. Copy `.env.example` to `.env` if using partner credentials. Start with `npm run dev`. Research imports run separately from the API. Reload Research and Sources after importing. No provider key is required for the local planner or public observations. Configure secrets on the server only: the API never returns a credential value, and the Sources tab shows only the variable name and whether it is set. What has been verified live, and what still needs credentials, is recorded in [INTEGRATIONS.md](INTEGRATIONS.md).

| Source and upstream | Integration | Access and scope |
| --- | --- | --- |
| [Open Prices API](https://prices.openfoodfacts.org/api/docs), [upstream repository](https://github.com/openfoodfacts/open-prices), [dataset](https://huggingface.co/datasets/openfoodfacts/open-prices) | `npm run worker` (add `-- --pages N` for up to 5 pages of 100) | Public dated evidence. Keeps GBP prices at GB locations, skips rows marked as duplicates and non-positive prices, and records promotions with the regular price and discount type. Transient failures (network errors, HTTP 429 and 5xx) are retried up to three times. No live branch stock guarantee. ODbL attribution and share-alike obligations. Stored in `observations`, apart from licensed data. |
| [Awin](https://help.awin.com/developers/docs/product-feed-publisher-guide-intro), [CSV parser](https://github.com/adaltas/node-csv) | `npm run research -- awin /path/to/feed.csv` | Use a decompressed, authorised GBP advertiser CSV with aw_product_id, product_name, currency and search_price. Optional and mapped when present: ean, product_GTIN or upc (barcode, check digit verified), condition, in_stock and stock_quantity (availability), delivery_cost, Fashion:size or size, colour, model_number, mpn or product_model (placeholders such as n/a are dropped), merchant_deep_link or aw_deep_link, merchant_name, last_updated, promotional_text, product_price_old and rrp_price (kept as claimed previous and recommended prices for comparison, never used as the cost). The standard feed has no pack column, so a feed offer reaches an exact match only after you confirm its pack in Research. A feed is an online offer: it never establishes branch stock. Sample access does not establish resale or republication rights. |
| [Hobnight OpenAPI](https://hobnight.com/openapi.yaml) | `npm run research -- hobnight "baby clothes"` or a GTIN | Server bearer key. Sends an 8, 12, 13 or 14 digit query as `gtin`, anything else as `q`, with `region=uk` and `per_page=100` (first page only). Catalogue evidence, branch unknown. Repeats within 6 hours reuse the stored rows. Confirm coverage and commercial rights with provider. |
| [Keepa API and official client](https://github.com/keepacom/api_backend) | `npm run research -- keepa ASIN` | Server API key. Uses domain 2, last 90 days, Amazon offer-price series only. `packageQuantity` is stored as the pack and `model` as the model when Keepa gives them. Requires subscription and consumes tokens. Repeats within 24 hours reuse the stored rows. Keepa error bodies are reported as failures. |
| [eBay Browse](https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search) | `npm run research -- ebay "cotton jumper"` or a GTIN | Supply a valid production OAuth application token with access to Browse. Queries EBAY_GB with `filter=itemLocationCountry:GB` and `limit=200`; a GTIN query uses `gtin` instead of `q`, as eBay requires. Records condition, seller, the cheapest stated GBP shipping (blank when none is stated), the listing's start date and URL; the row's source date is the time of the lookup, when the listing was seen live. Asking prices exclude separately charged shipping and are never used as sold prices. Listings count as competition for 7 days after the lookup; after that competition is unknown and a bounty cannot be shared until a new lookup. Repeats within 6 hours reuse the stored rows. Renew expired tokens before running. |
| [eBay Product Research](https://www.ebay.co.uk/help/selling/selling-tools/terapeak-research?id=4853) | `npm run research -- sales /path/to/sales.json` | Record permitted, manually checked completed sales. Restricted Marketplace Insights is not a dependency. |
| [The Range supplier interface](https://supplier.rstore.com/) | No catalogue connector | Supplier login for authorised users only; no verified public comparison catalogue. |
| [Fuel Finder](https://www.gov.uk/guidance/access-the-latest-fuel-prices-and-forecourt-data-via-api-or-email) | Candidate for journey costs | Optional future forecourt pricing. The API needs a GOV.UK One Login and OAuth 2.0 client credentials. The current profile takes user-entered trip costs. |

## Manual completed sales

Manual sales input is a JSON array. Each record needs:

- `reference`: a stable unique transaction reference. Importing the same reference updates the record.
- `title` and `variant`: the listing title and the exact variant sold.
- `barcode`: an 8, 12, 13 or 14 digit GTIN with a valid check digit.
- `condition`: as the listing stated it, for example `New` or `Used`.
- `soldDate`: `YYYY-MM-DD`, not in the future.
- `currency`: `GBP`.
- `totalPence`: a positive whole number of pence that the buyer actually paid, including buyer-paid postage.

Optional fields: `size`, `pack` and `model` (matching attributes, stored in lower case); `listedDate` (`YYYY-MM-DD`, not after `soldDate`, used for days to sell); `seller` or `listingId` (only a seller name counts towards independent sales; a listing id alone is stored as `listing:<id>` and never counts as an independent seller); `model` may be `none` when the item has no model number, which matches an offer you confirmed has none; `postagePence` (the postage part of the total, 0 to `totalPence`); `url` (the sold listing, `https://` only).

```json
[
  {
    "reference": "your-own-reference-1",
    "title": "Listing title as sold",
    "variant": "Exact size, colour and pack",
    "barcode": "<GTIN>",
    "condition": "New",
    "size": "M",
    "currency": "GBP",
    "totalPence": 1085,
    "postagePence": 285,
    "soldDate": "YYYY-MM-DD",
    "listedDate": "YYYY-MM-DD",
    "seller": "seller name"
  }
]
```

Any invalid record, including a total of 0, rejects the whole file, naming its index, so nothing is saved until the file is correct. The command reports how many sales have no seller name, because those are not counted as independent. These are self-reported research records, not independently verified or automatically promoted to buy alerts.

## Scheduling, import runs and readiness

For repeatable local scheduling, run `npm run worker:loop` in a separate process. The first run starts immediately; subsequent runs wait six hours after completion. A failed import is retried after 15 and then 45 minutes before returning to the six-hour cycle, and the worker itself retries transient network failures. Use a process supervisor for restart after a host reboot. Credentialed research is on demand to control cost.

Every import, scheduled or manual, successful, failed or served from the cache, is recorded in `import_runs` with its source, mode, query or file, row count and error. Errors pass through redaction so a credential can never be stored. The Sources tab shows, for each source, its configuration status, licence, rows stored, last successful fetch, last error and the 20 most recent runs. Open Prices is marked stale when it has had no successful import for 24 hours.

The repository's sample files in `server/fixtures/` are refused as evidence wherever they are copied to, and so is any file holding one of their rows.

Re-importing never duplicates rows: research rows are keyed by provider and source id, observations by Open Prices price id. A repeat refreshes the stored fields and the import time but keeps the first import time, and the source date (when the price was observed or the item sold) is always kept apart from both. Research snapshots show the latest imported details per source record; Keepa series use a distinct id per time point.

## Lookup cache

Credentialed lookups are cached locally by provider and query (case and spacing ignored): Keepa for 24 hours, Hobnight and eBay Browse for 6 hours. A repeat inside that window reuses the stored rows, makes no network call, does not change their import time and says so. Pass `--refresh` to fetch again, for example `npm run research -- ebay "cotton jumper" --refresh`. Failed lookups are not cached.

## Display permissions

Retailers and providers set display terms per programme. Record them in the Sources tab (or `POST /api/permissions` with `{ provider, programme, display, note }`). A record for one programme, such as an Awin advertiser entered exactly as the merchant name in the feed, overrides the provider-wide record (blank programme). For licensed feeds, provider data and self-reported sales, no record means display is not permitted, and the buy-alert gate fails closed. Open Prices data is published under the ODbL, which permits display with attribution. Programme names are compared without regard to case.

## Research

In Research, choose a barcoded acquisition offer, confirm any size, pack, model (or no model number) and condition the source left blank after looking at the item, select the reported sold variants you have checked, and enter your expected costs, journey cost and journey time (a blank journey is never treated as free). Enter the pilot locality so a branch check can count. The calculation uses the lower median buyer-paid total and shows contribution and earnings per active hour. Active asking prices are competition evidence only and never enter the sold sample (see ARCHITECTURE.md). No match leaves the estimate empty. This operator-led research view is separate from the simulated Leeds planner.

`GET /api/evidence?kind=&barcode=&q=&provider=&limit=&offset=` returns `{ rows, total }` (limit 100 by default, at most 500), so a caller can tell when more sold records exist than one page holds. `GET /api/observations?barcode=&limit=&offset=` returns Open Prices rows the same way.
