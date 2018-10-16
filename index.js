const fs = require("fs");
const path = require("path");

module.exports = (robot) => {
    const scriptDir = path.resolve(__dirname, 'src/scripts');
    fs.exists(scriptDir, res => {
        if (res) {
            for (var file of fs.readdirSync(scriptDir)) {
                if (file.endsWith(".js")) {
                    robot.loadFile(scriptDir, file);
                }
            }
        }
    });
};
