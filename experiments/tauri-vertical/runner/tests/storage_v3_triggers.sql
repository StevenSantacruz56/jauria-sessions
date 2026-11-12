-- Exact pre-schema5 trigger definitions for migration regression fixtures.
CREATE TRIGGER storage_delete_count AFTER DELETE ON events BEGIN
    UPDATE storage_meta SET physical_event_rows=physical_event_rows-1,
        event_rows=event_rows-(OLD.kind!='purged'),state_rows=state_rows-(OLD.kind='state'),
        output_encoded_bytes=output_encoded_bytes-CASE WHEN OLD.kind='output' THEN length(CAST(OLD.data AS BLOB)) ELSE 0 END WHERE singleton=1;
END;
CREATE TRIGGER storage_insert_count AFTER INSERT ON events BEGIN
    UPDATE storage_meta SET physical_event_rows=physical_event_rows+1,
        event_rows=event_rows+(NEW.kind!='purged'),state_rows=state_rows+(NEW.kind='state'),
        output_encoded_bytes=output_encoded_bytes+CASE WHEN NEW.kind='output' THEN length(CAST(NEW.data AS BLOB)) ELSE 0 END WHERE singleton=1;
END;
CREATE TRIGGER storage_insert_guard BEFORE INSERT ON events BEGIN
    SELECT CASE WHEN NEW.kind NOT IN ('state','purged') AND
        (SELECT event_rows>=max_event_rows-lifecycle_reserve_rows FROM storage_meta WHERE singleton=1)
        THEN RAISE(ABORT,'Storage retained event quota: lifecycle writes exempt; explicitly purge final output') END;
    SELECT CASE WHEN NEW.kind='output' AND
        (SELECT output_encoded_bytes+length(CAST(NEW.data AS BLOB))>max_output_encoded_bytes FROM storage_meta WHERE singleton=1)
        THEN RAISE(ABORT,'Storage output encoded byte quota; explicitly purge final history') END;
END;
CREATE TRIGGER storage_update_count AFTER UPDATE ON events BEGIN
    UPDATE storage_meta SET event_rows=event_rows+(NEW.kind!='purged')-(OLD.kind!='purged'),
        state_rows=state_rows+(NEW.kind='state')-(OLD.kind='state'),
        output_encoded_bytes=output_encoded_bytes
        -CASE WHEN OLD.kind='output' THEN length(CAST(OLD.data AS BLOB)) ELSE 0 END
        +CASE WHEN NEW.kind='output' THEN length(CAST(NEW.data AS BLOB)) ELSE 0 END WHERE singleton=1;
END;
CREATE TRIGGER storage_update_guard BEFORE UPDATE ON events BEGIN
    SELECT CASE WHEN NEW.kind NOT IN ('state','purged') AND OLD.kind='purged' AND
        (SELECT event_rows>=max_event_rows-lifecycle_reserve_rows FROM storage_meta WHERE singleton=1)
        THEN RAISE(ABORT,'Storage retained event quota') END;
    SELECT CASE WHEN NEW.kind='output' AND (SELECT output_encoded_bytes
        -CASE WHEN OLD.kind='output' THEN length(CAST(OLD.data AS BLOB)) ELSE 0 END
        +length(CAST(NEW.data AS BLOB))>max_output_encoded_bytes FROM storage_meta WHERE singleton=1)
        THEN RAISE(ABORT,'Storage output encoded byte quota') END;
END;
