require('dotenv').config();

const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'questionnaire_system';
const collections = ['answers', 'responses', 'jump_rules', 'questions', 'surveys', 'users'];

async function main() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(databaseName);
    for (const name of collections) {
      const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
      if (exists) {
        const result = await db.collection(name).deleteMany({});
        console.log(`${name}: removed ${result.deletedCount}`);
      } else {
        console.log(`${name}: collection not initialized`);
      }
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
