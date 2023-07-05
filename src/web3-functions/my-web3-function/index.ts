import { Web3Function, Web3FunctionContext } from "@gelatonetwork/web3-functions-sdk"
import { Contract, Event } from "ethers"

import controllerAbi from "../../abi/NewController.json"
import optionRegistryAbi from "../../abi/OptionRegistry.json"
import vaultCollateralMulticallAbi from "../../abi/VaultCollateralMulticall.json"

// block that the option regsitry was deployed on
const optionRegistryDeployBlock = 105497603

// Fill this out with your Web3 Function logic
Web3Function.onRun(async (context: Web3FunctionContext) => {
	const { storage, provider } = context

	const optionRegistryAddress = "0x8Bc23878981a207860bA4B185fD065f4fd3c7725"
	const controllerAddress = "0x594bD4eC29F7900AE29549c140Ac53b5240d4019"
	const multicallAddress = "0x622a3275d05F31F2f3AeDc439DE1e7913FB9fD59"

	// the block number on which this function was last called
	let lastQueryBlock
	// an array of vaultIDs which need their health factor checking
	let activeVaultIds
	// the vaultCount for the option registry on the last function call
	let previousVaultCount

	try {
		// get persistant variables from store
		lastQueryBlock = parseInt((await storage.get("lastQueryBlock")) ?? "0")

		activeVaultIds = JSON.parse((await storage.get("activeVaultIds")) ?? "[]")
		previousVaultCount = parseInt((await storage.get("previousVaultCount")) ?? "0")
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
	const multicall = await new Contract(multicallAddress, vaultCollateralMulticallAbi, provider)

	const currentBlock = await provider.getBlockNumber()
	// will contain emitted SettledVault events since the previous function execution
	let settleEvents: Event[] = []
	let liquidationEvents: Event[] = []
	// 10000000 block range is max limit for queries for some providers
	// if this is true something has probably gone wrong or it is the first run
	if (currentBlock > lastQueryBlock + 10000000) {
		for (let i = lastQueryBlock; i <= currentBlock; i = i + 10000000) {
			// iterate over 10000000 batches of blocks to catch up to currentBlock
			// find instances of settled vaults since the last query
			const settleEventsBatch = await controller.queryFilter(
				controller.filters.VaultSettled(),
				i,
				i + 9999999
			)
			// find instances of liquidated vaults since the last query
			const liquidationEventsBatch = await controller.queryFilter(
				controller.filters.VaultLiquidated(),
				i,
				i + 9999999
			)
			if (settleEventsBatch.length) {
				settleEvents.push(settleEventsBatch)
			}
			if (liquidationEventsBatch.length) {
				liquidationEvents.push(liquidationEventsBatch)
			}
		}
	} else {
		settleEvents = await controller.queryFilter(controller.filters.VaultSettled(), lastQueryBlock)
		liquidationEvents = await controller.queryFilter(
			controller.filters.VaultLiquidated(),
			lastQueryBlock
		)
	}
	settleEvents = settleEvents.flat()
	liquidationEvents = liquidationEvents.flat()
	console.log({ settleEvents, liquidationEvents })

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
	const additionalVaultIds = Array.from(Array(vaultCount + 1).keys()).slice(previousVaultCount + 1)
	console.log({ additionalVaultIds })

	// add newly created vault IDs to existing array of active vault IDs
	activeVaultIds.push(...additionalVaultIds)
	// remove activeVaultIds which appear in settledEventIds
	activeVaultIds = activeVaultIds.filter(id => !settledEventIds.includes(id))
	console.log({ activeVaultIds })

	let vaultsToAdjust: Number[] = []
	// multicall function will iterate over all IDs and check their health
	if (activeVaultIds.length) {
		// returns vaultID if vault needs adjusting, 0 if it does not.
		// filter elements that equal 0 out
		vaultsToAdjust = (await multicall.checkVaults(activeVaultIds))
			.map(id => id.toNumber())
			.filter(id => id != 0)
	}
	console.log(vaultsToAdjust)

	// update activeVaultIDs in storage
	await storage.set("activeVaultIds", JSON.stringify(activeVaultIds))
	// update previousVaultCount in storage
	await storage.set("previousVaultCount", vaultCount.toString())
	// set last query block to current block value
	await storage.set("lastQueryBlock", currentBlock.toString())
	// if true, this will signal to the gelato executor to call the adjust function on the multicall contract
	// the multicall contract will loop through the array calling optionRegistry.adjustCollateral on each vault ID in the callData payload.
	if (vaultsToAdjust.length) {
		// Return execution call data
		return {
			canExec: true,
			callData: multicall.interface.encodeFunctionData("adjustVaults", [vaultsToAdjust])
		}
	} else {
		return {
			canExec: false,
			message: "No vault to adjust"
		}
	}
})
