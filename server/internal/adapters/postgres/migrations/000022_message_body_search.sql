-- Search is a derived read model. Retain non-message identity/version rows so
-- delayed workers cannot resurrect an older message or invalidate checkpoints.
ALTER TABLE project_search_documents ADD COLUMN event_kind TEXT NOT NULL DEFAULT '';
UPDATE project_search_documents d SET event_kind=e.kind
FROM canonical_events e WHERE e.id=d.event_id AND d.publication_head='';
-- Unchanged descriptors can reuse a document from a reclaimed older head.
-- Classify against current membership, never against the historical index head.
UPDATE project_search_documents d SET event_kind=coalesce(
 (convert_from(p.validated_body,'UTF8')::jsonb -> 'Events' -> m.entry_index ->> 'Kind'), '')
FROM canonical_publication_sources s
JOIN canonical_publication_members m ON m.attempt_id=s.current_head::uuid AND m.kind='event'
JOIN canonical_publication_parts p ON p.attempt_id=m.attempt_id AND p.ordinal=m.part_ordinal
WHERE d.publication_head<>'' AND s.session_id=d.session_id
 AND m.record_id=d.event_id AND m.search_descriptor=d.publication_descriptor;

DROP INDEX project_search_documents_vector_idx;
ALTER TABLE project_search_documents DROP COLUMN search_vector;
UPDATE project_search_documents SET
 text=CASE WHEN event_kind='message' THEN text ELSE '' END,
 tool_label='',
 search_text=CASE WHEN event_kind='message' THEN lower(text) ELSE '' END;

-- Windowed characters avoid repeatedly slicing a large UTF-8 input from its
-- beginning. Include short grams, symbols and whitespace without tokenization.
CREATE FUNCTION search_body_grams(body TEXT, minimum_width INTEGER, maximum_width INTEGER)
RETURNS TEXT[] LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
 WITH characters AS (
  SELECT ch, lead(ch,1) OVER (ORDER BY n) AS next1,
         lead(ch,2) OVER (ORDER BY n) AS next2
  FROM unnest(string_to_array(body,NULL)) WITH ORDINALITY AS c(ch,n)
 ), grams AS (
  SELECT ch AS gram FROM characters WHERE minimum_width<=1 AND maximum_width>=1
  UNION ALL
  SELECT ch||next1 FROM characters WHERE minimum_width<=2 AND maximum_width>=2
  UNION ALL
  SELECT ch||next1||next2 FROM characters WHERE minimum_width<=3 AND maximum_width>=3
 ) SELECT coalesce(array_agg(DISTINCT gram) FILTER (WHERE gram IS NOT NULL),'{}'::text[]) FROM grams
$$;
ALTER TABLE project_search_documents ADD COLUMN body_grams TEXT[]
 GENERATED ALWAYS AS (search_body_grams(search_text,1,3)) STORED;
CREATE INDEX project_search_message_grams_idx ON project_search_documents USING GIN(body_grams)
 WHERE event_kind='message';
CREATE INDEX project_search_message_page_idx
 ON project_search_documents(project_id,occurred_at DESC,event_id DESC) WHERE event_kind='message';
ANALYZE project_search_documents;
