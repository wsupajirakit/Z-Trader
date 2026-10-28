// Runs ONCE, when the mongo container starts with an empty data volume (docker-entrypoint-initdb.d).
// It creates the least-privilege user the app connects as: readWrite on the app database only. It has
// no role on admin, config or any other database, and can't manage users.
//
// The values come from the mongo container's environment (set in docker-compose.yml). The script logs
// names only, never the password.
//
// Changing MONGO_APP_PASSWORD later does NOT re-run this script. See docs/deploy.md, "Rotate the database
// password".

const dbName = process.env.MONGO_APP_DB;
const user = process.env.MONGO_APP_USER;
const pwd = process.env.MONGO_APP_PASSWORD;

if (!dbName || !user || !pwd) {
    throw new Error('init-app-user: MONGO_APP_DB, MONGO_APP_USER and MONGO_APP_PASSWORD must all be set');
}

const appDb = db.getSiblingDB(dbName);

if (appDb.getUser(user)) {
    print(`init-app-user: user "${user}" already exists on "${dbName}", leaving it unchanged`);
} else {
    appDb.createUser({
        user,
        pwd,
        roles: [{ role: 'readWrite', db: dbName }],
    });
    print(`init-app-user: created user "${user}" with readWrite on "${dbName}"`);
}
