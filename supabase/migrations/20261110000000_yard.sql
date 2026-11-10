-- Where the trucks start and end the day. Picked from Google Maps in the owner's setup; routes are
-- planned from here and the live map shows it.
alter table public.companies add column yard_address text;
alter table public.companies add column yard_lat double precision check (yard_lat between -90 and 90);
alter table public.companies add column yard_lng double precision check (yard_lng between -180 and 180);
alter table public.companies add column yard_place_id text;
-- Google's id for each property address, so the same place picked twice is recognised.
alter table public.properties add column place_id text;
