# Superteam submission checklist

Everything below is either already done or is a step only the account holder can
take. Tick them off in order.

## Deliverables

| Requirement | Where it lives | Status |
|---|---|---|
| Public GitHub repo | https://github.com/makinokennn/t3n-vendor-guard | **Done** |
| Screenshots | 15 files in `docs/screenshots/`, 3 embedded inline in the README | **Done** |
| Bug report | `BUGS.md`: 5 confirmed with reproductions, 3 withdrawn | **Done** |
| Public Google Doc | copy `SUBMISSION.md` into a Doc | **To do** |
| X post tagging @terminal3io | `docs/tweet.txt` | **To do** |

The Google Doc must be set to **Anyone with the link -> Viewer**, and the same
link goes in the Superteam form.

### Making the Doc

Pasting `SUBMISSION.md` straight into Google Docs gives literal pipes and
backticks, because Docs does not read markdown. Paste the rendered version
instead:

```bash
python3 tools/make_submission_html.py     # writes docs/SUBMISSION.html
```

Open `docs/SUBMISSION.html` in a browser, select all, copy, and paste into the
Doc. The tables, headings and code blocks come across as real Docs elements.
Then fill in `<DOC_URL>` in `SUBMISSION.md` and push.

## Eligibility questions

The listing asks three. Answers are prepared; copy them across.

**1. Email address**

Use the same work email you claimed the tenant with. Personal domains are
rejected by the claim page, so if you got past it, this address is fine.

**2. What is your DID generated from the page?**

```
t3n:027196549993299f1ba80f717605e98e2f8595e2
```

**3. Would you want to continue running this / pass it to us to run it?**

> Hand it over, with a documented process, and we would stay available.
>
> We built it so that the handover is a checklist rather than an archaeology
> project, because a submission that only works in its author's head is not
> maintainable. `docs/HANDOVER.md` contains the day-1 checklist, an honest
> "what breaks first" list ordered by likelihood, the cost model (one outbound
> call per payout), the safe way to change policy, and the three things we would
> add before real money moves.
>
> The two things that make a handover viable are both already true: the policy
> engine is pure and tested without any infrastructure, and the component is
> committed as a hash-verifiable artifact, so the inheritor can confirm they are
> running what was reviewed before they change a line.

## How the work is judged

From the listing, in the order it states them:

1. **Time to submit.** Earlier is better. The repo has been public since
   2026-09-15 and is complete; do not sit on the form.
2. **Build quality (usefulness and ease to maintain)**, called out as VERY
   IMPORTANT. The policy engine is pure and host-free, there are 35 Rust and 42
   TypeScript tests, and `docs/HANDOVER.md` is written for the next person.
3. **Documentation quality.** README, `docs/ARCHITECTURE.md`,
   `docs/THREAT-MODEL.md`, `docs/SETUP.md`, `docs/HANDOVER.md`.
4. **Bug submission quality.** `BUGS.md`, including the findings we withdrew.
5. **Bonus:** the X post.

## Before you submit

- [ ] Revoke every GitHub token pasted into chat
- [ ] Google Doc created, set to "Anyone with the link -> Viewer"
- [ ] `SUBMISSION.md`'s `<DOC_URL>` filled in and pushed
- [ ] Superteam form filled, three answers above copied in
- [ ] X post published, tagging @terminal3io

## If a tenant gets claimed later

Step 7 in `docs/SETUP.md` is the only unverified part. Once a tenant exists:

```bash
cd agent
export T3N_API_KEY=<from the claim page>
npx tsx src/admin.ts whoami      # confirm the DID matches the one above
```

Then run the walkthrough's register and invoke steps, and update the "What is
verified, and what is not" table in `SUBMISSION.md`. Until then that table is
accurate and should not be edited to claim more.
