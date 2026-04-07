$tsNodeDev = "D:\projects\INVONE\INVONESOURCE\node_modules\.bin\ts-node-dev.cmd"
$tsConfig = "D:\projects\INVONE\INVONESOURCE\backend\tsconfig.json"
$entryPoint = "D:\projects\INVONE\INVONESOURCE\backend\src\index.ts"
& $tsNodeDev --respawn --transpile-only --project $tsConfig $entryPoint
