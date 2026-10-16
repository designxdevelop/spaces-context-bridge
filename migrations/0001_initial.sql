-- Fresh schema for Spaces Context Bridge 0.1.x.
-- IF NOT EXISTS keeps this a no-op on databases that already have these tables
-- (deployments created before migrations were adopted), so their data is preserved.
-- Column order matters: the Worker uses positional INSERT ... VALUES and INSERT ... SELECT.
CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,name TEXT,redirects TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS consents(id TEXT PRIMARY KEY,csrf TEXT,data TEXT,expires INTEGER);
CREATE TABLE IF NOT EXISTS codes(hash TEXT PRIMARY KEY,client TEXT,redirect TEXT,challenge TEXT,role TEXT,expires INTEGER);
CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY,client TEXT,role TEXT,expires INTEGER,kind TEXT);
CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,client TEXT,idem TEXT,kind TEXT,payload TEXT,status TEXT,result TEXT,created INTEGER,updated INTEGER,lease TEXT,lease_expires INTEGER,UNIQUE(client,idem));
CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY,callback TEXT,secret TEXT,expires INTEGER,created INTEGER,client TEXT,previous_secret TEXT,rotate_until INTEGER);
CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,subscription TEXT,request TEXT,attempts INTEGER DEFAULT 0,due INTEGER,status TEXT DEFAULT 'pending',UNIQUE(subscription,request));
CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,n INTEGER NOT NULL,expires INTEGER NOT NULL);
