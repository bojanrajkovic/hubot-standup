const fs = require("fs");
const path = require("path");

module.exports = (robot) => {
    path = path.resolve(__dirname, 'src/scripts');
    fs.exists(path, exists => {
        if (exists)
            for (var file of fs.readdirSync(path))
                robot.loadFile(path);
    });
};
