-- Seed links (INSERT OR IGNORE so re-running never overwrites a changed destination)
INSERT OR IGNORE INTO links (slug, label, destination) VALUES
  ('wss',          'General',        'https://www.worldspiritualitysummit.com/register?utm_source=rjs&utm_medium=paid_referral&utm_campaign=wss2026'),
  ('wss-insta',    'Instagram',      'https://www.worldspiritualitysummit.com/register?utm_source=rjs&utm_medium=paid_referral&utm_campaign=wss2026'),
  ('wss-whatsapp', 'WhatsApp',       'https://www.worldspiritualitysummit.com/register?utm_source=rjs&utm_medium=paid_referral&utm_campaign=wss2026'),
  ('wss-poster',   'Print / Poster', 'https://www.worldspiritualitysummit.com/register?utm_source=rjs&utm_medium=paid_referral&utm_campaign=wss2026');
