# The FPL Fraud Detector

A reputation system for every manager in our FPL mini league (league `566171`). It pulls real data from the official FPL website, scores everyone, and publishes a site to GitHub Pages that refreshes itself every 6 hours.

## The scores

| Score | What it measures |
|---|---|
| **Fraud probability** | Chance a manager slides down the table soon. Blends overperformance, luck, upcoming fixture difficulty, recent form, how high they currently sit, and where their previous seasons say they should be. |
| **Lucky bastard index** | Captain points above what their expected goals and assists deserved, plus points rescued by automatic substitutes. |
| **Transfer regret** | Points lost compared with keeping the player they sold, from the week of the transfer until the new player was sold again. Hits included. |
| **Benchwarmer crimes** | Points left on the bench. Bench Boost weeks excused. Includes their single worst benching. |
| **Overachiever alert** | Actual starting XI points minus expected points (real goals and assists swapped for expected goals and assists). |
| **AI suspicion** | Template ownership, copying the most popular captain, never taking hits, transfers that always land, and no previous seasons. |

Previous seasons come from each manager's FPL history (final points and overall rank per season) and feed the fraud probability and each manager's rap sheet.

## Setup (about 5 minutes)

1. **Create the repo.** On GitHub, create a new empty repository, for example `fpl-fraud-detector`.
2. **Upload the code.** Either push it with git:
   ```bash
   git init
   git add .
   git commit -m "FPL Fraud Detector"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/fpl-fraud-detector.git
   git push -u origin main
   ```
   or use **Add file > Upload files** on the repo page and drag in everything from this folder (including the `.github` folder).
3. **Turn on Pages.** Repo **Settings > Pages > Build and deployment > Source**, choose **GitHub Actions**.
4. **Run it.** Go to the **Actions** tab, pick **Update league and deploy**, click **Run workflow**. After a minute or two the site is live at `https://billysavery.github.io/PeoplevsChrislewis/`.

From then on it updates itself every 6 hours.

## Changing league

Edit `leagueId` in `config.json` and push. That's it.

## Running it on your own computer

Needs Node 20 or newer.

```bash
npm run update   # fetch real league data and score it
npm run demo     # or: generate a dummy league instead
npm run serve    # open the site at http://localhost:3000
```

## Files

* `scripts/fetch.mjs` pulls the league, every manager's picks, transfers and history, plus player stats and fixtures from the FPL API.
* `scripts/score.mjs` calculates every score and writes `site/data.json`.
* `scripts/mock.mjs` makes a fake league for testing.
* `site/` is the website itself (plain HTML, CSS and JavaScript, no build step).
* `.github/workflows/update.yml` runs the fetch, scores it and deploys to Pages on a schedule.

## Notes

* Transfer regret compares total points of the two players each week, whether or not they started.
* Expected points use the official FPL expected goals and assists, with goals worth 10 (GK), 6 (DEF), 5 (MID) and 4 (FWD), and assists worth 3.
* Not affiliated with the Premier League or FPL.
