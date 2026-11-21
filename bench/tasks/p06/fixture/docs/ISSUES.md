# slotwise issue tracker export

Open issues, oldest first. Reporters are venue staff and integrators; the text is theirs.

---

## #1 Back-to-back bookings are refused
- Reporter: front desk, Harbour Studio
- Labels: bookings
- Opened: 2025-01-14

We run 1 hour sessions in Room A. If 09:00-10:00 is taken I should be able to book 10:00-11:00 straight after,
but slotwise says `slot not available`. Booking 10:01 works, so it looks like the end minute counts as taken.
Also happens with two different customers, no buffer set on the room.

## #2 Extra opening window makes the room look like it closes at noon
- Reporter: Dana, ops
- Labels: availability, rules
- Opened: 2025-01-20

Room B is open 09:00-17:00 on Mondays. I added a rule for an extra 10:00-12:00 window on Mondays (we use it for
a weekly workshop). Now `free` for a Monday lists nothing after 12:00 even though the room is empty all
afternoon. Without the rule the full day shows.

## #3 Hours ending at 24:00 are rejected
- Reporter: night-bar integration
- Labels: hours
- Opened: 2025-01-29

Setting hours `fri=18:00-24:00` fails with `invalid hours for fri`. Midnight closing is normal for us. 23:59
works but then the last minute can never be booked.

## #4 Weekly rule drops its final date
- Reporter: Priya
- Labels: rules
- Opened: 2025-02-03

I made a weekly Wednesday rule starting 2025-04-02 with an end date of 2025-04-30. The dates I get stop at
2025-04-23. The 30th is a Wednesday and the end date is supposed to be included. Rules with a count are fine.

## #5 Cleaning buffer only works after a session
- Reporter: Harbour Studio
- Labels: bookings, buffer
- Opened: 2025-02-07

Room A has a 15 minute buffer. After a 10:00-11:00 booking nobody can start before 11:15, which is right. But
someone just booked 09:30-09:55, which ends only five minutes before the 10:00 session starts, so there was no
time to clean before it.

## #6 Waitlist promoted two people into one chair
- Reporter: Moe, salon
- Labels: waitlist, capacity
- Opened: 2025-02-11

Chair 3 holds one booking at a time. Two people were waiting for overlapping times on Tuesday. I cancelled the
booking that was in the way and both of them got promoted, so now the chair has two bookings at the same time.
I expected the first person on the list to get it and the second to keep waiting.

## #7 Cancelled slot still shows as taken
- Reporter: Dana, ops
- Labels: cancellation, cache
- Opened: 2025-02-19

After `cancel`, `free` still lists the old time as busy. It corrects itself as soon as someone makes another
booking on that resource. A fresh process shows the right slots straight away.

## #8 Bulk import lost bookings without saying why
- Reporter: Chen, integrations
- Labels: batch, import
- Opened: 2025-02-24

I imported a file of 40 bookings. Output said `booked 37` and listed no failures, but I expected three of
them to clash with existing bookings. I have no way to find out which three were skipped.

## #9 Report total shows a fraction of a minute
- Reporter: finance export
- Labels: report
- Opened: 2025-03-02

The TOTAL row of the weekly report printed `65.00000000000001` in the booked column. Our spreadsheet import
chokes on it. Individual resource rows are whole numbers. Minutes are supposed to be integers everywhere.

## #10 Equal resources come out in the wrong order
- Reporter: Moe, salon
- Labels: report, list
- Opened: 2025-03-05

Two chairs with exactly the same booked minutes show up in reverse order of how we created them in the report.
The same thing happens in `list`: when two bookings start at the same minute (different customers on a shared
resource) the one made later is printed first. We want ties left in creation order.

## #11 Running the CLI wrapper twice in one process fails the second time
- Reporter: Chen, integrations
- Labels: cli
- Opened: 2025-03-06

Our script builds one `args` array and calls `run(args)` for a dry run and again for the real run. The second
call prints the usage line and exits 2. After the first call the array we passed in is empty.

## #12 Failed commands exit with status 0
- Reporter: CI maintainer
- Labels: cli
- Opened: 2025-03-09

`slotwise cancel --id b99` prints `error: unknown booking: b99` but the exit status is 0, so our pipeline keeps
going. Same for a booking that clashes. Successful commands are fine.
