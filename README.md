# Artifact Explorer

This is a library containing all core logic to explore all [LDN+AS2](https://www.eventnotifications.net/#Activities)
notifications belonging to a certain artifact.

Currently, its intended usage is to be used in the [scholarly-browser application](https://github.com/MellonScholarlyCommunication/scholarly-browser).

## Installation

```bash
# Clone the repository
git clone git@github.com:MellonScholarlyCommunication/artifact-explorer.git
cd artifact-explorer

# Install dependencies
npm install

# Build the library
npm run build

# Then, to be able to use the library in another project like the scholarly-browser, NPM link it
npm link
# And in the scholarly-browser project, link it
cd ../scholarly-browser
npm link artifact-explorer
```
