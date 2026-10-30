-- Practice voyages may be started by a guest and claimed afterwards, when the explorer adds a name.
alter table practice_runs alter column player drop not null;
