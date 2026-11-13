const argument = process.argv[2]
if (typeof argument === 'string' && argument.length <= 16_384) {
  process.stderr.write('YFE_ACP_AUTH:' + JSON.stringify(argument) + '\n')
}
