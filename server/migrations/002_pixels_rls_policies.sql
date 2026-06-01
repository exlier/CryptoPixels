-- Row Level Security policies for the pixels table.

ALTER TABLE pixels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public select pixels" ON pixels
  FOR SELECT
  USING (true);

CREATE POLICY "Service role insert pixels" ON pixels
  FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role update pixels" ON pixels
  FOR UPDATE
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role delete pixels" ON pixels
  FOR DELETE
  USING (auth.role() = 'service_role');
