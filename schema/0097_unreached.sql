CREATE TABLE unreached (plan INTEGER PRIMARY KEY REFERENCES plans(id), failed INTEGER NOT NULL CHECK (failed > 0));
