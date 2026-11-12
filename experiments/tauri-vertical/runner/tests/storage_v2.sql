-- Frozen pre-release v2 storage schema fixture.
CREATE INDEX IF NOT EXISTS session_states ON events(session_id,kind,seq);
                CREATE TABLE IF NOT EXISTS storage_meta(
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    output_encoded_bytes INTEGER NOT NULL, event_rows INTEGER NOT NULL,
                    max_output_encoded_bytes INTEGER NOT NULL, max_event_rows INTEGER NOT NULL,
                    lifecycle_reserve_rows INTEGER NOT NULL, output_rejected INTEGER NOT NULL DEFAULT 0);
                INSERT INTO storage_meta SELECT 1,
                    COALESCE(SUM(CASE WHEN kind='output' THEN length(CAST(data AS BLOB)) ELSE 0 END),0),
                    COUNT(*),134217728,200000,4096,0 FROM events HAVING NOT EXISTS(SELECT 1 FROM storage_meta);
                CREATE TRIGGER IF NOT EXISTS storage_insert_guard BEFORE INSERT ON events BEGIN
                    SELECT CASE WHEN (SELECT event_rows>=max_event_rows FROM storage_meta WHERE singleton=1)
                        THEN RAISE(ABORT,'Storage event row quota exhausted (lifecycle reserve included)') END;
                    SELECT CASE WHEN NEW.kind!='state' AND (SELECT event_rows>=max_event_rows-lifecycle_reserve_rows FROM storage_meta WHERE singleton=1)
                        THEN RAISE(ABORT,'Storage event row quota: lifecycle reserve protected; explicitly purge final history') END;
                    SELECT CASE WHEN NEW.kind='output' AND (SELECT output_encoded_bytes+length(CAST(NEW.data AS BLOB))>max_output_encoded_bytes FROM storage_meta WHERE singleton=1)
                        THEN RAISE(ABORT,'Storage output encoded byte quota; explicitly purge final history') END;
                END;
                CREATE TRIGGER IF NOT EXISTS storage_insert_count AFTER INSERT ON events BEGIN
                    UPDATE storage_meta SET event_rows=event_rows+1,
                        output_encoded_bytes=output_encoded_bytes+CASE WHEN NEW.kind='output' THEN length(CAST(NEW.data AS BLOB)) ELSE 0 END WHERE singleton=1;
                END;
                CREATE TRIGGER IF NOT EXISTS storage_delete_count AFTER DELETE ON events BEGIN
                    UPDATE storage_meta SET event_rows=event_rows-1,
                        output_encoded_bytes=output_encoded_bytes-CASE WHEN OLD.kind='output' THEN length(CAST(OLD.data AS BLOB)) ELSE 0 END WHERE singleton=1;
                END;
                CREATE TRIGGER IF NOT EXISTS storage_update_guard BEFORE UPDATE ON events BEGIN
                    SELECT CASE WHEN NEW.kind='output' AND (SELECT output_encoded_bytes
                        -CASE WHEN OLD.kind='output' THEN length(CAST(OLD.data AS BLOB)) ELSE 0 END
                        +length(CAST(NEW.data AS BLOB))>max_output_encoded_bytes FROM storage_meta WHERE singleton=1)
                        THEN RAISE(ABORT,'Storage output encoded byte quota') END;
                END;
                CREATE TRIGGER IF NOT EXISTS storage_update_count AFTER UPDATE ON events BEGIN
                    UPDATE storage_meta SET output_encoded_bytes=output_encoded_bytes
                        -CASE WHEN OLD.kind='output' THEN length(CAST(OLD.data AS BLOB)) ELSE 0 END
                        +CASE WHEN NEW.kind='output' THEN length(CAST(NEW.data AS BLOB)) ELSE 0 END WHERE singleton=1;
                END;
