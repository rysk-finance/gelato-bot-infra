import {
  Web3Function,
  Web3FunctionContext,
} from "@gelatonetwork/web3-functions-sdk";
import { Contract, ethers , Event} from "ethers";

import controllerAbi from "../../abi/NewController.json"
import optionRegistryAbi from "../../abi/OptionRegistry.json"
import vaultCollateralMulticallAbi from "../../abi/VaultCollateralMulticall.json"

// block that the option regsitry was deployed on
const optionRegistryDeployBlock = 25976032


// Fill this out with your Web3 Function logic
Web3Function.onRun(async (context: Web3FunctionContext) => {
  const { storage, provider } = context;
  
  const optionRegistryAddress = "0x04706DE6cE851a284b569EBaE2e258225D952368"
	const controllerAddress = "0x594bD4eC29F7900AE29549c140Ac53b5240d4019"
  const multicallAddress = "0xa304d4418E6f4dFCEc90A73E478FDB950Fd70385"

  // the block number on which this function was last called
	let lastQueryBlock
	// an array of vaultIDs which need their health factor checking
	let activeVaultIds
	// the vaultCount for the option registry on the last function call
	let previousVaultCount
	// multiple of upperHeathFactor above which extra collateral is removed
	const upperhealthFactorBuffer = 1.1

  try {
		// get persistant variables from store
		lastQueryBlock = parseInt(
			await storage.get("lastBlockNumber") ?? "0"
		)

		activeVaultIds = JSON.parse(await storage.get("activeVaultIds") ?? "[]")
		previousVaultCount = parseInt(await storage.get("mainnetPreviousVaultCount") ?? "0")
		console.log({ lastQueryBlock, activeVaultIds, previousVaultCount })
	} catch (err) {
		console.log("error retrieving data from store")
		console.log(err)
	}
	// if these are undefined, it must be the first function call or the data is corrupted so build from scratch
	if (!activeVaultIds || !lastQueryBlock || !previousVaultCount) {
		activeVaultIds = []
		lastQueryBlock = optionRegistryDeployBlock
		previousVaultCount = 0
	}

  const optionRegistry = await new Contract(optionRegistryAddress, optionRegistryAbi, provider)
  const controller = await new Contract(controllerAddress, controllerAbi, provider)
  const multicall = await new Contract(multicallAddress,vaultCollateralMulticallAbi, provider )

	const currentBlock = await provider.getBlockNumber()
	// will contain emitted SettledVault events since the previous function execution
	let settleEvents: Event[] = []
	let liquidationEvents: Event[] = []
	
  settleEvents = await controller.queryFilter(
    controller.filters.VaultSettled(),
    lastQueryBlock
  )
  liquidationEvents = await controller.queryFilter(
    controller.filters.VaultLiquidated(),
    lastQueryBlock
  )
  settleEvents = settleEvents
  liquidationEvents = liquidationEvents

  // set last query block to current block value
	await storage.set(
		"mainnetCollateralThresholdLastQueryBlock",
		currentBlock.toString()
	)
	// return vault IDs of settled vault events where the vault owner is the option registry
	let settledEventIds: Number[] = []
	if (settleEvents.length) {
		settledEventIds = settleEvents
			.filter(event => event?.args?.accountOwner == optionRegistryAddress)
			.map(event => event?.args?.vaultId.toNumber())
	}
	if (liquidationEvents.length) {
		settledEventIds.push(
			liquidationEvents
				.filter(event => event?.args?.vaultOwner == optionRegistryAddress)
				.map(event => event?.args?.vaultId.toNumber())
		)
	}
	console.log({ settledEventIds })
	// check how many vaults have ever existed
	const vaultCount = (await optionRegistry.vaultCount()).toNumber()
	console.log("vault count:", vaultCount)

	// create an array of vault IDs that have been created since last execution
	const additionalVaultIds = Array.from(Array(vaultCount + 1).keys()).slice(
		previousVaultCount + 1
	)
	console.log({ additionalVaultIds })
	// update previousVaultCount in storage
	await storage.set("mainnetPreviousVaultCount", vaultCount.toString())
	// add newly created vault IDs to existing array of active vault IDs
	activeVaultIds.push(...additionalVaultIds)
	// remove activeVaultIds which appear in settledEventIds
	activeVaultIds = activeVaultIds.filter(id => !settledEventIds.includes(id))
	// update activeVaultIDs in storage
	await storage.set("mainnetActiveVaultIds", JSON.stringify(activeVaultIds))
	console.log({ activeVaultIds })

  // the below code needs to be replaced with a function call to a multi-call contract
  // the multi-call contract function will take a bool and array of vaultIDs
  // 
  
  let vaultsToAdjust: Number[] = []
	// iterate over vaults and check health. adjust if needed
	if (activeVaultIds.length) {
    vaultsToAdjust = (await multicall.checkVaults(activeVaultIds)).map(id => id.toNumber()).filter(id => id != 0)
	}
  console.log(vaultsToAdjust)
  // if true, this will signal to the gelato executor to call a function on a multicall contract
  // the multicall contract will loop through the array calling optionRegistry.adjustCollateral on each vault ID in the callData payload.
  if (vaultsToAdjust.length){
    // Return execution call data
    return {
      canExec: true,
      callData: vaultsToAdjust
    }
  } else {
    return {
      canExec: false,
      callData: vaultsToAdjust
    }
  }
});
