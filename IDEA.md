The problem - while looking for a job I need to maintain a spreadsheet of companies, descriptions, salaries, open roles and their status, where I applied, feedback, etc.
which is very time consuming and error prone.

The solution - a piece of software that would do all that for me.
Use case:
1. I open the software - let's start with minimal UI, CLI only.
2. Actions I can do:
2.1. Add a new target company. To avoid confusion I will need to add the companies url. Software would async fetch the companies name, description.
2.2. Add a new role - again, I'll need a url. Software would add company details from 2.1.
2.3. Change a roles status - whether I want to skip it, delay it (todo), whether I've already applied, whether It was a success or failure (denied).
I will need to be able to add various references related to role - for example when applying I want to save the details I used when filling the application form (or however I applied).
I need to have a copy of the CV I sent over.

Note regarding actions, periodic events, etc - all of them need a timestamp and context, for later debugging if needed.

Periodically software would refetch role URLs to check if they're still available.
Notify me when they're closed.

Periodically software would fetch roles from careers pages, filter based on my preferences,
and notify me if there's anything potentially interesting.

When adding a role, whether manually or periodically, software should fetch compensation - min/max salaries (I need to setup some way of getting that, glassdoor, fyi, other),
equity, whether company has IPO'd (or is planning to).

All of the above can be rerun manually if needed. Can be a separate command, that runs automatically after certain events.

Other fetched/derived data that's relevant:
- Whether the role is remote and available in EU.
- How AI proof/future proof the company is.
- Work life balance from online sources.

